# B7 — Structural Decomposition

Goal: reduce engineering and AI-agent context bottlenecks after runtime optimizations are stable.

These phases should normally run last because they overlap files changed by earlier bottleneck fixes.

Phases:

1. Decompose upload orchestration.
2. Decompose Remote Import processor.
3. Decompose Telegram sync service.
4. Decompose major frontend pages/components.
