<script lang="ts">
    import { orpc, queryClient } from "$lib/api/orpc";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import { toastManager } from "$lib/components/ui/toast";
    import { createMutation } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import { watch } from "runed";

    type Machine = {
        id: string;
        name: string;
        state: string;
        connected?: boolean;
    };

    let {
        clusterId,
        machines,
    }: { clusterId: string; machines: Machine[] } = $props();

    const removal = useQueryStates(
        { dialog: parseAsString, machine: parseAsString },
        { shallow: true, scroll: false },
    );

    // Stoat can't remove the machine it reaches the cluster through.
    const machine = $derived(
        removal.dialog.current === "remove-machine"
            ? machines.find(
                  (item) =>
                      item.id === removal.machine.current &&
                      !item.connected,
              )
            : undefined,
    );

    const down = $derived(machine?.state.toLowerCase() === "down");

    function close() {
        void removal.set({ dialog: null, machine: null });
    }

    const removeMutation = createMutation(() =>
        orpc.cluster.removeMachine.mutationOptions({
            onSuccess: async ({ name, reset }, variables) => {
                toastManager.add(
                    reset
                        ? {
                              type: "success",
                              title: `Removed ${name}`,
                              description:
                                  "Its containers are gone and the server was reset, so it can be added again.",
                          }
                        : {
                              type: "warning",
                              title: `Removed ${name}`,
                              description:
                                  "Stoat couldn't reset it, so run uncloud-uninstall on the server before adding it again.",
                          },
                );
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.getCluster.queryKey({
                        input: { clusterId: variables.clusterId },
                    }),
                });

                if (clusterId === variables.clusterId) close();
            },
        }),
    );

    watch(
        () => machine?.id,
        (id) => {
            if (id) removeMutation.reset();
        },
    );
</script>

<ConfirmDialog
    bind:open={
        () => machine !== undefined,
        (value) => {
            if (!value && machine) close();
        }
    }
    title={`Remove ${machine?.name ?? "machine"}?`}
    description={down
        ? `${machine?.name} is down, so it's only taken out of the cluster. Its containers keep running on the server until you reset it with uncloud-uninstall.`
        : `Its containers are removed and the server is reset, so it can be added again. Services running only there stop until they're deployed again; named volumes stay on the server.`}
    confirmLabel="Remove machine"
    pending={removeMutation.isPending}
    error={removeMutation.error?.message ?? ""}
    onconfirm={() => {
        if (machine)
            removeMutation.mutate({
                clusterId,
                machineId: machine.id,
            });
    }}
/>
