<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import {
        Tabs,
        TabsList,
        TabsPanel,
        TabsTab,
    } from "$lib/components/ui/tabs";
    import CreateClusterForm from "./create-cluster-form.svelte";
    import ProvisionClusterForm from "./provision-cluster-form.svelte";

    let {
        open = $bindable(false),
        source = $bindable("connect"),
        onprovision,
    }: {
        open?: boolean;
        source?: "connect" | "server";
        onprovision: (provisionId: string) => void;
    } = $props();

    // Only the active tab's form is mounted, so both share these.
    let pending = $state(false);

    let canSubmit = $state(false);
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Create Cluster</DialogTitle>
            <DialogDescription>
                Clusters run your projects' resources.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <Tabs
                value={source}
                onValueChange={(value) => {
                    if (value === "connect" || value === "server")
                        source = value;
                }}
            >
                <TabsList class="mb-4 w-full">
                    <TabsTab value="connect" disabled={pending}>
                        Connect existing
                    </TabsTab>
                    <TabsTab value="server" disabled={pending}>
                        New server
                    </TabsTab>
                </TabsList>
                <TabsPanel value="connect">
                    <CreateClusterForm
                        formId="create-cluster-form"
                        bind:pending
                        bind:canSubmit
                        oncreated={() => {
                            open = false;
                        }}
                    />
                </TabsPanel>
                <TabsPanel value="server">
                    <ProvisionClusterForm
                        formId="provision-cluster-form"
                        bind:pending
                        bind:canSubmit
                        oncreated={onprovision}
                    />
                </TabsPanel>
            </Tabs>
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                disabled={pending}
                onclick={() => {
                    open = false;
                }}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form={source === "server"
                    ? "provision-cluster-form"
                    : "create-cluster-form"}
                loading={pending}
                disabled={!canSubmit}
            >
                {source === "server" ? "Continue" : "Create Cluster"}
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
