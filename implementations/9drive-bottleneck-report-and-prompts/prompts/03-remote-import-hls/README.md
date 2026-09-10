# B3 — Remote Import / HLS Resources

Goal: keep Remote Import and HLS feature-complete while preventing temp-disk, FFmpeg, and segment concurrency from destabilizing the server.

Phases:

1. Resource observability and admission control.
2. Separate direct/HLS concurrency budgets.
3. Add resumable stream-through direct imports where safe.
4. Add global HLS resource controls and validate failure recovery.
