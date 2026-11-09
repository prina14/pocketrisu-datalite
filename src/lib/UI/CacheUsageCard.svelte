<script lang="ts">
    import { onMount } from 'svelte';
    import { HardDrive, RefreshCw } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { readCacheUsage, formatCacheBytes, type CacheUsageSnapshot } from 'src/ts/storage/cacheUsage';
    import ShButton from './GUI/ShButton.svelte';

    let snapshot = $state<CacheUsageSnapshot | null>(null);
    let refreshing = $state(true);
    let failed = $state(false);
    let active = false;
    let running = false;
    let refreshController: AbortController | null = null;
    let resumeRefresh = false;

    const hasQuota = $derived(
        snapshot?.source === 'browser' && snapshot.usageBytes !== null &&
        snapshot.quotaBytes !== null && snapshot.quotaBytes > 0
    );
    const percentage = $derived(hasQuota
        ? Math.min(100, Math.max(0, snapshot!.usageBytes! / snapshot!.quotaBytes! * 100))
        : null);
    const remaining = $derived(hasQuota
        ? Math.max(0, snapshot!.quotaBytes! - snapshot!.usageBytes!)
        : null);
    const pressure = $derived(percentage !== null && percentage >= 95 ? 'high'
        : percentage !== null && percentage >= 85 ? 'medium' : 'normal');

    async function refresh(force = false) {
        if (!active || running || document.hidden) return;
        running = true;
        refreshing = true;
        const controller = new AbortController();
        refreshController = controller;
        try {
            const result = await readCacheUsage({ force, signal: controller.signal });
            if (active) { snapshot = result; failed = false; }
        } catch {
            if (active && !controller.signal.aborted) failed = true;
        } finally {
            if (refreshController === controller) refreshController = null;
            running = false;
            if (active) {
                refreshing = false;
                if (resumeRefresh && !document.hidden) {
                    resumeRefresh = false;
                    void refresh();
                }
            }
        }
    }

    onMount(() => {
        active = true;
        void refresh();
        const onVisible = () => {
            if (document.hidden) refreshController?.abort();
            else if (running) resumeRefresh = true;
            else void refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            active = false;
            refreshController?.abort();
            document.removeEventListener('visibilitychange', onVisible);
        };
    });
</script>

<section
    class="mt-4 w-full rounded-2xl border border-borderc/15 bg-darkbg px-4 py-4 sm:px-5"
    aria-label={language.cacheUsageTitle}
    aria-busy={refreshing}
>
    <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-selected text-textcolor2">
                <HardDrive size={20} aria-hidden="true" />
            </div>
            <div class="min-w-0">
                <h2 class="text-sm font-semibold text-textcolor">{language.cacheUsageTitle}</h2>
                <p class="mt-0.5 text-xs text-textcolor2">{language.cacheUsageDevice}</p>
            </div>
        </div>
        <ShButton
            variant="ghost"
            size="icon-sm"
            disabled={refreshing}
            aria-label={language.cacheUsageRefresh}
            title={language.cacheUsageRefresh}
            onclick={() => { void refresh(true); }}
        >
            <RefreshCw size={16} class={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
        </ShButton>
    </div>

    {#if !snapshot && refreshing}
        <p class="mt-4 text-sm text-textcolor2" role="status">{language.cacheUsageLoading}</p>
    {:else if snapshot?.usageBytes !== null && snapshot?.usageBytes !== undefined}
        <div class="mt-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div>
                <p class="text-xs text-textcolor2">
                    {snapshot.source === 'browser' ? language.cacheUsageUsed : language.cacheUsageKnown}
                </p>
                <div class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
                    <span class="text-2xl font-semibold tracking-tight text-textcolor sm:text-3xl">
                        {formatCacheBytes(snapshot.usageBytes)}
                    </span>
                    {#if hasQuota}
                        <span class="text-sm text-textcolor2">/ {formatCacheBytes(snapshot.quotaBytes!)}</span>
                    {/if}
                </div>
            </div>
            {#if hasQuota}
                <div class="text-right text-xs text-textcolor2">
                    <span class="block">{language.cacheUsageRemaining}</span>
                    <span class="mt-1 block font-medium tabular-nums text-textcolor">{formatCacheBytes(remaining!)}</span>
                </div>
            {:else}
                <span class="rounded-full border border-borderc/15 px-2.5 py-1 text-xs text-textcolor2">
                    {language.cacheUsageQuotaUnknown}
                </span>
            {/if}
        </div>

        {#if hasQuota}
            <div
                class="mt-3 h-2.5 overflow-hidden rounded-full bg-selected"
                role="progressbar"
                aria-label={language.cacheUsageMeter}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percentage!)}
                aria-valuetext={`${formatCacheBytes(snapshot.usageBytes)} / ${formatCacheBytes(snapshot.quotaBytes!)}`}
            >
                <div
                    class="h-full rounded-full transition-[width] duration-300 {pressure === 'high' ? 'bg-red-400' : pressure === 'medium' ? 'bg-amber-400' : 'bg-emerald-400'}"
                    style:width={`${percentage}%`}
                ></div>
            </div>
            <div class="mt-2 flex items-center justify-between gap-3 text-xs">
                <span class={pressure === 'high' ? 'text-red-400' : pressure === 'medium' ? 'text-amber-400' : 'text-textcolor2'}>
                    {pressure === 'normal' ? language.cacheUsageQuotaLabel : language.cacheUsageNearlyFull}
                </span>
                <span class="shrink-0 tabular-nums text-textcolor2">{percentage!.toFixed(1)}%</span>
            </div>
        {/if}

        <p class="mt-3 text-xs leading-relaxed text-textcolor2">
            {snapshot.source === 'browser' ? language.cacheUsageEstimateNote : language.cacheUsageFallbackNote}
        </p>
    {:else}
        <p class="mt-4 text-sm leading-relaxed text-textcolor2">{language.cacheUsageUnavailable}</p>
    {/if}

    {#if failed}
        <p class="mt-2 text-xs text-amber-400" role="status">{language.cacheUsageRefreshFailed}</p>
    {/if}
</section>
