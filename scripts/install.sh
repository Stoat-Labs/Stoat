#!/usr/bin/env bash
# Usage: curl -fsSL https://raw.githubusercontent.com/Stoat-Labs/Stoat/master/scripts/install.sh | bash

set -euo pipefail

STOAT_RAW_URL="https://raw.githubusercontent.com/Stoat-Labs/Stoat/master"
UNCLOUD_INSTALL_URL="https://get.uncloud.run/install.sh"
SIDECAR_URL="http://sidecar.internal"

if [ -t 1 ]; then
    BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' YELLOW=$'\033[33m' GREEN=$'\033[32m' RESET=$'\033[0m'
else
    BOLD="" DIM="" RED="" YELLOW="" GREEN="" RESET=""
fi

UC=""
STOAT_DIR=""
EXISTING_ENV=""
APP_URL=""
SSH_TARGET=""
CLUSTER_SUMMARY=""
ANSWER=""

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
note() { printf '    %s\n' "$1"; }
notice() { printf '    %sNote:%s %s\n' "$YELLOW" "$RESET" "$1"; }
die() {
    printf '\n%sError:%s %s\n' "$RED" "$RESET" "$1" >&2
    exit 1
}
stop() {
    printf '\n%s\n' "$1"
    exit 0
}

# Prompts read from /dev/tty because under `curl | bash` stdin is the script itself.
prompt() {
    local question=$1 default=${2:-} reply
    if [ -n "$default" ]; then
        printf '    %s %s[%s]%s: ' "$question" "$DIM" "$default" "$RESET" >/dev/tty
    else
        printf '    %s: ' "$question" >/dev/tty
    fi
    read -r reply </dev/tty || die "Input closed."
    ANSWER=${reply:-$default}
}

confirm() {
    local question=$1 default=$2 hint reply
    if [ "$default" = "y" ]; then hint="Y/n"; else hint="y/N"; fi
    while true; do
        printf '    %s [%s]: ' "$question" "$hint" >/dev/tty
        read -r reply </dev/tty || die "Input closed."
        case "${reply:-$default}" in
            [yY] | [yY][eE][sS]) return 0 ;;
            [nN] | [nN][oO]) return 1 ;;
            *) printf '    Please answer y or n.\n' >/dev/tty ;;
        esac
    done
}

random_hex() {
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

read_env_value() {
    sed -n "s/^$1=//p" "$2" | head -n 1 | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//' | tr -d "\"'"
}

normalize_domain() {
    local value
    value=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    value=${value#http://}
    value=${value#https://}
    value=${value%%/*}
    printf '%s' "${value%.}"
}

is_valid_domain() {
    printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
}

print_intro() {
    cat <<EOF

${BOLD}Stoat installer${RESET}

  1. Install the Uncloud CLI (uc) if it's missing
  2. Use your Uncloud cluster, or create one on your server over SSH
  3. Download compose.yml and generate .env with random secrets
  4. Deploy Stoat with uc deploy

EOF
}

ensure_uc() {
    step "Uncloud CLI"
    if UC=$(command -v uc); then
        note "Found uc at $UC"
        return
    fi
    note "Stoat is deployed with the Uncloud CLI (uc), which isn't installed."
    confirm "Install it now with Uncloud's official installer?" y ||
        stop "Install uc from https://uncloud.run, then run this script again."
    curl -fsSL "$UNCLOUD_INSTALL_URL" | sh || die "Installing uc failed. See the output above."
    hash -r
    UC=$(command -v uc) || UC="${INSTALL_DIR:-/usr/local/bin}/uc"
    [ -x "$UC" ] || die "uc was installed but isn't on your PATH. Add its directory to PATH and run this script again."
}

choose_directory() {
    step "Install directory"
    note "Stoat's compose.yml and .env (which holds its secrets) are saved here."
    prompt "Directory" "$PWD/stoat"
    case "$ANSWER" in
        \~) ANSWER=$HOME ;;
        \~/*) ANSWER="$HOME/${ANSWER#\~/}" ;;
        /*) ;;
        *) ANSWER="$PWD/$ANSWER" ;;
    esac
    STOAT_DIR=${ANSWER%/}
    if [ -f "$STOAT_DIR/.env" ]; then
        EXISTING_ENV=1
    fi
}

use_existing_cluster() {
    local context=$1
    note "Found the '$context' cluster in your Uncloud config. Checking its machines..."
    if ! "$UC" machine ls; then
        notice "Couldn't connect to the '$context' cluster."
        confirm "Set up a new cluster on a server instead?" y ||
            die "Make sure the '$context' cluster's machines are reachable, or switch clusters with 'uc ctx use <name>', then run this script again."
        return 1
    fi
    confirm "Deploy Stoat to this cluster? Answer n to set up a new one on another server." y || return 1
    if [ -z "$EXISTING_ENV" ] && "$UC" inspect stoat >/dev/null 2>&1; then
        die "Stoat is already deployed on '$context'. Deploying it with new secrets would lock it out of its database. Run this script again and enter the directory that holds that deployment's .env."
    fi
    CLUSTER_SUMMARY="existing cluster '$context'"
}

choose_cluster() {
    step "Uncloud cluster"
    local context
    context=$("$UC" ctx show 2>/dev/null || true)
    if [ -z "$context" ]; then
        note "No Uncloud cluster found, so one will be created on your server."
    elif use_existing_cluster "$context"; then
        return
    fi

    note "This runs 'uc machine init', which installs Docker and Uncloud on the server over SSH."
    note "Your SSH key must already be authorized on it, and the user must be root or have passwordless sudo."
    while true; do
        prompt "Server SSH address, e.g. root@203.0.113.10 or ubuntu@my-server:2222"
        case "$ANSWER" in
            *[[:space:]]* | "") note "Enter the address as user@host." ;;
            ?*@?*) break ;;
            *) note "Include the user, e.g. root@$ANSWER" ;;
        esac
    done
    SSH_TARGET=$ANSWER
    CLUSTER_SUMMARY="new cluster on $SSH_TARGET"
}

choose_domain() {
    step "Domain"
    if [ -n "$EXISTING_ENV" ]; then
        APP_URL=$(read_env_value APP_URL "$STOAT_DIR/.env")
        [ -n "$APP_URL" ] ||
            die "$STOAT_DIR/.env has no APP_URL. Set it, or remove the file to start fresh, then run this script again."
        note "Keeping the existing $STOAT_DIR/.env and its secrets."
        note "Domain: $APP_URL (edit APP_URL in that file to change it)"
        return
    fi
    note "Stoat will be served over HTTPS on this domain."
    while true; do
        prompt "Domain, e.g. stoat.example.com"
        APP_URL=$(normalize_domain "$ANSWER")
        if is_valid_domain "$APP_URL"; then
            break
        fi
        note "'$ANSWER' isn't a valid domain. Enter something like stoat.example.com."
    done
}

confirm_plan() {
    step "Ready to install"
    note "Cluster:    $CLUSTER_SUMMARY"
    note "Domain:     https://$APP_URL"
    note "Directory:  $STOAT_DIR"
    if [ -z "$EXISTING_ENV" ]; then
        note "Secrets:    generated into $STOAT_DIR/.env"
    fi
    # IP addresses need no DNS record.
    case "$APP_URL" in
        *[a-z]*)
            printf '\n'
            notice "$APP_URL needs a DNS record (A or AAAA) pointing to your server's public IP, so Caddy can issue its HTTPS certificate."
            ;;
    esac
    printf '\n'
    confirm "Continue?" y || stop "Cancelled."
}

write_config() {
    step "Writing config files"
    mkdir -p "$STOAT_DIR"
    if [ -f "$STOAT_DIR/compose.yml" ]; then
        note "Keeping the existing compose.yml"
    else
        curl -fsSL "$STOAT_RAW_URL/compose.yml" -o "$STOAT_DIR/compose.yml.tmp" ||
            die "Couldn't download compose.yml from $STOAT_RAW_URL."
        mv "$STOAT_DIR/compose.yml.tmp" "$STOAT_DIR/compose.yml"
        note "Downloaded compose.yml"
    fi

    if [ -n "$EXISTING_ENV" ]; then
        return
    fi
    local example="$STOAT_DIR/.env.example.tmp" env_tmp="$STOAT_DIR/.env.tmp" key
    curl -fsSL "$STOAT_RAW_URL/.env.example" -o "$example" ||
        die "Couldn't download .env.example from $STOAT_RAW_URL."
    (
        umask 077
        awk -v app_url="$APP_URL" -v app_secret="$(random_hex)" \
            -v postgres_password="$(random_hex)" -v sidecar_token="$(random_hex)" '
            /^APP_URL=/ { print "APP_URL=" app_url; next }
            /^APP_SECRET=/ { print "APP_SECRET=" app_secret; next }
            /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" postgres_password; next }
            /^SIDECAR_TOKEN=/ { print "SIDECAR_TOKEN=" sidecar_token; next }
            { print }
        ' "$example" >"$env_tmp"
    )
    rm -f "$example"
    for key in APP_URL APP_SECRET POSTGRES_PASSWORD SIDECAR_TOKEN; do
        grep -q "^$key=." "$env_tmp" || die ".env.example no longer defines $key. Please report this at https://github.com/Stoat-Labs/Stoat/issues."
    done
    mv "$env_tmp" "$STOAT_DIR/.env"
    note "Generated .env with random secrets"
}

init_cluster() {
    if [ -z "$SSH_TARGET" ]; then
        return
    fi
    step "Creating the cluster on $SSH_TARGET"
    local before after
    before=$("$UC" ctx show 2>/dev/null || true)
    if "$UC" machine init "$SSH_TARGET" </dev/tty; then
        return
    fi
    # uc switches to the new cluster's context as soon as the cluster exists.
    after=$("$UC" ctx show 2>/dev/null || true)
    if [ -z "$after" ] || [ "$after" = "$before" ] || ! "$UC" machine ls >/dev/null 2>&1; then
        die "Creating the cluster failed. Fix the error above and run this script again; your .env is kept."
    fi
    printf '\n'
    notice "The cluster was created, but uc reported an error afterwards (see above)."
    confirm "Deploy Stoat to the new cluster anyway?" y ||
        stop "The cluster is ready. Run this script again, or 'uc deploy' in $STOAT_DIR, when you want to deploy Stoat."
}

deploy() {
    step "Deploying Stoat"
    note "uc shows the deployment plan next. Type y to confirm it."
    (cd "$STOAT_DIR" && "$UC" deploy </dev/tty) ||
        die "Stoat wasn't deployed (see uc's message above). When you're ready, run 'uc deploy' in $STOAT_DIR or run this script again."
}

print_next_steps() {
    local token
    token=$(read_env_value SIDECAR_TOKEN "$STOAT_DIR/.env")
    cat <<EOF

${BOLD}${GREEN}Stoat is deployed.${RESET}

Open ${BOLD}https://$APP_URL${RESET} and follow the setup wizard:
  1. Create your account. The first account becomes the instance admin.
  2. Name your organization.
  3. Connect your cluster with:
       Sidecar URL:    $SIDECAR_URL
       Sidecar token:  $token

Your config is in $STOAT_DIR. Keep its .env safe: APP_SECRET encrypts the secrets Stoat stores.
To redeploy later, run ${BOLD}uc deploy${RESET} in that directory.
EOF
}

main() {
    if ! { : </dev/tty; } 2>/dev/null; then
        die "This installer asks a few questions, so it needs an interactive terminal."
    fi
    command -v curl >/dev/null 2>&1 || die "curl is required."

    print_intro
    ensure_uc
    choose_directory
    choose_cluster
    choose_domain
    confirm_plan
    write_config
    init_cluster
    deploy
    print_next_steps
}

main "$@"
