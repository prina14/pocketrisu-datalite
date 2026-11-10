<script lang="ts">
    import type { Component, Snippet } from 'svelte';
    import { LoaderCircleIcon } from '@lucide/svelte';
    import { language } from 'src/lang';

    interface Props {
        load: () => Promise<{ default: Component<any> }>;
        children: Snippet<[Component<any>]>;
        overlay?: boolean;
        close?: () => void;
    }

    let { load, children, overlay = false, close }: Props = $props();
    let loaded = $state<Component<any> | null>(null);
    let failed = $state(false);
    let attempt = $state(0);

    $effect(() => {
        attempt;
        const loader = load;
        let active = true;
        loaded = null;
        failed = false;
        // The boundary is mounted only when its screen/dialog is requested.
        Promise.resolve().then(loader).then(module => {
            if (active) loaded = module.default;
        }).catch(() => {
            if (active) failed = true;
        });
        return () => { active = false; };
    });
</script>

{#if loaded}
    {@render children(loaded)}
{:else}
    <div
        class="flex min-h-40 items-center justify-center p-6 {overlay ? 'fixed inset-0 z-40 bg-black/50 backdrop-blur-sm' : 'h-full w-full'}"
    >
        <div class="flex max-w-md flex-col items-center gap-3 rounded-xl border border-darkborderc bg-darkbg p-6 text-center text-textcolor" role="status" aria-live="polite">
            {#if failed}
                <p class="text-sm">{language.errors.networkFetch}</p>
            {:else}
                <LoaderCircleIcon class="size-6 animate-spin text-textcolor2" aria-hidden="true" />
                <p class="text-sm">{language.loading}…</p>
            {/if}
            {#if failed || close}
                <div class="flex items-center gap-2">
                    {#if failed}
                        <button class="rounded-md border border-darkborderc px-3 py-2 text-sm hover:bg-selected" onclick={() => { attempt += 1; }}>
                            {language.errors.chatLoadRetry}
                        </button>
                    {/if}
                    {#if close}
                        <button class="rounded-md border border-darkborderc px-3 py-2 text-sm hover:bg-selected" onclick={close}>
                            {language.close}
                        </button>
                    {/if}
                </div>
            {/if}
        </div>
    </div>
{/if}
