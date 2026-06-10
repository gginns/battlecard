# Battlecard

A Foundry VTT module for the **dnd5e** system that replaces the fragmented attack workflow with a **single two-phase dialog** and **one evolving chat card** per attack sequence.

Hit/miss adjudication stays fully human — the GM declares hit or miss verbally, the player presses **Damage**, **Critical**, or **Miss**. Battlecard automates choreography, never rules. It never reads or compares target AC, never applies damage, and never handles saving throws.

## Target environment

- **Foundry VTT:** v13 / v14 (developed against v14 stable)
- **dnd5e system:** 4.1+ / 5.x (developed against 5.3.2) — uses the Activities API
- **Dependencies:** none. Dice So Nice supported automatically.

## How it works

1. Use a weapon or spell with an **attack-roll activity** → Battlecard's dialog opens instead of the system dialog (hold **Shift** to bypass and get the vanilla flow).
2. **Phase 1 — Attack:** see your current target, toggle Advantage/Normal/Disadvantage, add a situational bonus, pick a roll mode, then **Roll Attack** (or toggle manual entry and type your physical d20's face value).
3. The chat card appears and the dialog auto-advances to **Phase 2 — Damage** with the attack total pinned at the top. Nobody is ever asked "did that hit?" — the GM says it out loud.
4. Press **Damage**, **Critical** (pre-highlighted on a nat 20), or **Miss** (pre-highlighted on a nat 1, but Damage stays clickable — GM's call).
5. **Done** ends the sequence (and optionally auto-clears your targets). **Attack Again** loops back to Phase 1 with the same item for Extra Attack / Multiattack — the same chat card grows another attack block.

One card in chat tells the whole story.

## Installation (manual)

1. Copy this folder into your Foundry user data directory as `Data/modules/battlecard/` (the folder containing `module.json` must be named `battlecard`).
2. Restart Foundry (or hit *Return to Setup*), then enable **Battlecard** in your world's *Manage Modules*.

## Roadmap

- **M1 (current):** interception, two-phase dialog, evolving chat card, manual dice entry, roll modes, Attack Again, auto-clear targets.
- **M2:** Resume button on abandoned cards, cross-client socket updates, "Whisper to specific players" roll mode.
- **M3:** pulsing target reticle (double-ripple), current-target HUD chip.

## Known v1 limitations

- One target per attack roll; "Attack Again" covers multiattacks.
- Spell attacks are cast at base level (the system's configuration dialog, where upcasting lives, is suppressed by design — hold Shift to bypass Battlecard when you want to upcast).
- Bonus dice from features (Hex, Hunter's Mark, Sneak Attack) are typed into the situational bonus field manually.
