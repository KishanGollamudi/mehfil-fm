<script>
  import { fade } from 'svelte/transition';

  let { message = '', visible = false } = $props();
</script>

{#if visible && message}
  <div class="toast" role="status" transition:fade={{ duration: 160 }}>
    {message}
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    z-index: 20;
    right: 24px;
    bottom: 100px;
    max-width: min(360px, calc(100vw - 32px));
    padding: 13px 17px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    box-shadow: 0 12px 36px #0008;
    font-size: 0.9rem;
  }
</style>
