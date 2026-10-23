import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
import KeyRound from "@lucide/svelte/icons/key-round";
import Lock from "@lucide/svelte/icons/lock";
import Settings from "@lucide/svelte/icons/settings-2";
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
import User from "@lucide/svelte/icons/user";
import Users from "@lucide/svelte/icons/users";
import { parseAsStringLiteral } from "nuqs-svelte";
import type { Component } from "svelte";

export const sections = [
    "profile",
    "preferences",
    "security",
    "organization",
    "members",
    "api-keys",
    "danger",
] as const;

export type SettingsSectionId = (typeof sections)[number];

export type SettingsNavGroup = {
    label: string;
    items: { value: SettingsSectionId; label: string; icon: Component }[];
};

export const sectionParser = parseAsStringLiteral(sections);

export function isOwner(role: string) {
    return role.split(",").some((item) => item.trim() === "owner");
}

export function settingsGroups(
    organization: { name: string; role: string } | undefined,
): SettingsNavGroup[] {
    const account: SettingsNavGroup = {
        label: "Account",
        items: [
            { value: "profile", label: "Profile", icon: User },
            { value: "preferences", label: "Preferences", icon: SlidersHorizontal },
            { value: "security", label: "Security", icon: Lock },
        ],
    };

    if (!organization) return [account];

    const ownerItems: SettingsNavGroup["items"] = isOwner(organization.role)
        ? [
              { value: "api-keys", label: "API keys", icon: KeyRound },
              { value: "danger", label: "Danger zone", icon: TriangleAlert },
          ]
        : [];

    return [
        account,
        {
            label: organization.name,
            items: [
                { value: "organization", label: "General", icon: Settings },
                { value: "members", label: "Members", icon: Users },
                ...ownerItems,
            ],
        },
    ];
}

// Falls back to Profile when the section is unknown or hidden from this
// user, e.g. a non-owner opening ?section=api-keys.
export function activeSection(groups: SettingsNavGroup[], value: string | null) {
    return (
        groups.flatMap((group) => group.items).find((item) => item.value === value)?.value ??
        "profile"
    );
}
