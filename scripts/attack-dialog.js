import {
  MODULE_ID, advModes, damageTypeLabel, dnd5eApi, firstTarget, fromUuidCompat, fromUuidSyncCompat,
  getRollClass, isNumericBonus, log, normalizeBonus, parseToHit, parseTypedBonus,
  parseTypedManualDamage, rollModeOptions, showDice, snapshotToken, targetCount, warn
} from "./util.js";
import { initialRollMode } from "./settings.js";
import { createSequenceMessage, refreshMessageDisplay, updateSequenceMessage } from "./chat-card.js";
import { autoClearTargets, startTargetPick } from "./targeting.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The single two-phase attack dialog.
 *
 * Phases: "attack" (configure & roll to-hit) → "damage" (Damage / Critical /
 * Miss; the roller is never asked whether they hit — the GM declares it
 * verbally) → "post" (Done / Attack Again).
 *
 * Hard rule: this class never reads or compares target AC.
 */
export class BattlecardDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.activity = options.activity;
    this.manualAttack = false;
    this.manualDamage = false;
    const resume = options.resume;
    if (resume) {
      // Reconstruct an abandoned sequence from the card's flags (§7).
      const state = resume.state;
      this.phase = state.phase ?? "attack";
      this.rollMode = state.rollMode ?? initialRollMode();
      this.whisperIds = new Set(state.whisperIds ?? []);
      this.ownerUserId = state.ownerUserId ?? game.user.id;
      this.sequence = { attacks: foundry.utils.deepClone(state.attacks ?? []) };
      if (!this.sequence.attacks.length) this.#pushNewAttack();
      // Guard against odd states: damage/post phases need an attack result.
      if (this.phase !== "attack" && !this.current?.attack) this.phase = "attack";
      this.#message = resume.message;
    } else {
      this.phase = "attack";
      this.rollMode = initialRollMode();
      this.whisperIds = new Set();
      this.ownerUserId = game.user.id;
      this.sequence = { attacks: [] };
      this.#pushNewAttack();
    }
  }

  /** @type {BattlecardDialog|null} The one open dialog on this client. */
  static current = null;

  #message = null;       // the evolving ChatMessage for this sequence
  #finished = false;     // Done was pressed
  #cancelPick = null;    // active pick-mode canceller
  #busy = false;         // roll in flight; ignore re-clicks

  /**
   * Live target panel: retargeting natively (T key etc.) while in the attack
   * phase refreshes the panel. Pick mode has its own handler, so skip then.
   */
  #onUserRetarget = user => {
    if (user !== game.user || this.phase !== "attack" || this.#cancelPick) return;
    const entry = this.current;
    if (!entry || entry.attack) return;
    entry.target = snapshotToken(firstTarget());
    entry.multipleTargets = targetCount() > 1;
    if (this.rendered) this.render();
  };

  static DEFAULT_OPTIONS = {
    id: "battlecard-dialog",
    classes: ["battlecard-dialog"],
    tag: "div",
    window: {
      icon: "fa-solid fa-hand-fist",
      minimizable: true,
      resizable: false
    },
    position: { width: 420, height: "auto" },
    actions: {
      setAdvantage: BattlecardDialog.#onSetAdvantage,
      toggleManual: BattlecardDialog.#onToggleManual,
      changeTarget: BattlecardDialog.#onChangeTarget,
      noTarget: BattlecardDialog.#onNoTarget,
      rollAttack: BattlecardDialog.#onRollAttack,
      rollDamage: BattlecardDialog.#onRollDamage,
      rollCritical: BattlecardDialog.#onRollCritical,
      miss: BattlecardDialog.#onMiss,
      done: BattlecardDialog.#onDone,
      attackAgain: BattlecardDialog.#onAttackAgain
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/dialog.hbs` }
  };

  /* -------------------------------------------- */
  /*  Convenience accessors                       */
  /* -------------------------------------------- */

  get item() { return this.activity?.item; }
  get actor() { return this.activity?.actor; }

  /** Attacking token — synthetic token actors included (unlinked tokens). */
  get token() {
    return this.actor?.token?.object ?? this.actor?.getActiveTokens?.()[0] ?? null;
  }

  get current() { return this.sequence.attacks.at(-1); }

  get title() { return this.item?.name ?? game.i18n.localize("BATTLECARD.Dialog.Title"); }

  /** Id of this sequence's chat card, if one exists yet. */
  get messageId() { return this.#message?.id ?? null; }

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */

  /** Open the dialog for an attack activity, replacing any prior instance. */
  static async open(activity, { resume = null } = {}) {
    if (BattlecardDialog.current) {
      try { await BattlecardDialog.current.close(); } catch (e) { /* already closed */ }
    }
    const options = { activity };
    if (resume) options.resume = resume;
    const pos = game.settings.get(MODULE_ID, "dialogPosition");
    if (Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
      options.position = { left: pos.left, top: pos.top };
    }
    const dialog = new BattlecardDialog(options);
    BattlecardDialog.current = dialog;
    dialog.render({ force: true });
    // Hide the card's Resume button on this client while the dialog is open.
    if (resume?.message) refreshMessageDisplay(resume.message);
    return dialog;
  }

  /**
   * Resume an abandoned sequence from its chat card (§7). Reopens the dialog
   * at the abandoned phase with full context rebuilt from the card's flags.
   */
  static async resume(message) {
    const state = message.getFlag(MODULE_ID, "state");
    if (!state || state.complete) return null;
    if (game.user.id !== state.ownerUserId && !game.user.isGM) return null;
    let activity = null;
    try {
      activity = await fromUuidCompat(state.activityUuid);
    } catch (e) { /* item gone */ }
    if (typeof activity?.rollAttack !== "function") {
      // Attacker lost the item mid-sequence (§11): fail gracefully.
      ui.notifications.warn(game.i18n.localize("BATTLECARD.Notifications.ResumeFailed"));
      return null;
    }
    return this.open(activity, { resume: { message, state } });
  }

  /* -------------------------------------------- */
  /*  Sequence state                              */
  /* -------------------------------------------- */

  #pushNewAttack() {
    const target = firstTarget();
    this.sequence.attacks.push({
      target: snapshotToken(target),
      multipleTargets: targetCount() > 1,
      advMode: 0,
      attackMode: this.#defaultAttackMode(),
      situational: "",
      damageSituational: "",
      manualValue: "",
      manualDamageValue: "",
      attack: null,
      damage: null
    });
  }

  /** Valid attack modes for this weapon (one-/two-handed, thrown, ...). */
  #attackModes() {
    try {
      const modes = this.item?.system?.attackModes;
      const arr = Array.isArray(modes) ? modes : (modes ? Array.from(modes) : []);
      return arr
        .map(m => ({ value: m?.value ?? m, label: m?.label ?? String(m?.value ?? m) }))
        .filter(m => m.value);
    } catch (e) {
      return [];
    }
  }

  #defaultAttackMode() {
    const modes = this.#attackModes();
    if (!modes.length) return "";
    let last = null;
    try {
      last = this.item?.getFlag("dnd5e", `last.${this.activity.id}.attackMode`);
    } catch (e) { /* flag unreadable */ }
    return modes.some(m => m.value === last) ? last : modes[0].value;
  }

  /** Serializable sequence state stored in the chat card's flags (§6). */
  #buildState() {
    return {
      version: 1,
      ownerUserId: this.ownerUserId,
      whisperIds: [...this.whisperIds],
      itemUuid: this.item?.uuid ?? null,
      activityUuid: this.activity?.uuid ?? null,
      attackerTokenUuid: this.token?.document?.uuid ?? null,
      actorName: this.token?.name ?? this.actor?.name ?? "?",
      actorImg: this.token?.document?.texture?.src ?? this.actor?.img ?? null,
      itemName: this.item?.name ?? "?",
      itemImg: this.activity?.img || this.item?.img || null,
      rollMode: this.rollMode,
      phase: this.phase,
      complete: this.#finished,
      attacks: foundry.utils.deepClone(this.sequence.attacks)
    };
  }

  async #syncCard() {
    const state = this.#buildState();
    try {
      if (!this.#message) {
        const speaker = ChatMessage.implementation.getSpeaker({
          actor: this.actor,
          token: this.token?.document
        });
        this.#message = await createSequenceMessage(state, { speaker });
      } else {
        await updateSequenceMessage(this.#message.id, state);
      }
    } catch (e) {
      warn("Card sync failed", e);
      ui.notifications.error(game.i18n.localize("BATTLECARD.Notifications.CardUpdateFailed"));
    }
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _prepareContext(_options) {
    const entry = this.current;
    const base = {
      phase: this.phase,
      isAttackPhase: this.phase === "attack",
      isDamagePhase: this.phase === "damage",
      isPostPhase: this.phase === "post",
      actorName: this.token?.name ?? this.actor?.name ?? "?",
      actorImg: this.token?.document?.texture?.src ?? this.actor?.img ?? null,
      itemName: this.item?.name ?? "?",
      itemImg: this.activity?.img || this.item?.img || null,
      attackNumber: this.sequence.attacks.length,
      showAttackCounter: this.sequence.attacks.length > 1
    };

    if (this.phase === "attack") {
      return {
        ...base,
        target: entry.target,
        targetMissing: this.#targetMissing(entry),
        multipleTargets: entry.multipleTargets,
        isAdv: entry.advMode === 1,
        isNormal: entry.advMode === 0,
        isDis: entry.advMode === -1,
        formula: this.#attackFormulaDisplay(),
        situational: entry.situational,
        consumptionNotice: this.sequence.attacks.length === 1 ? this.#consumptionNotice() : null,
        attackModes: this.#attackModes().map(m => ({ ...m, selected: m.value === entry.attackMode })),
        showAttackModes: this.#attackModes().length > 1,
        rollModes: rollModeOptions(this.rollMode),
        showWhisperList: this.rollMode === "whisper",
        whisperTargets: this.#whisperTargets(),
        manual: this.manualAttack,
        manualValue: entry.manualValue,
        manualTotal: this.#manualAttackTotalDisplay()
      };
    }

    // Damage + post phases share a template.
    const attack = entry.attack ?? {};
    const hideResult = this.rollMode === "blindroll" && !game.user.isGM;
    return {
      ...base,
      target: entry.target,
      attackTotal: hideResult ? "??" : attack.total,
      d20: hideResult ? null : attack.d20,
      isCrit: !hideResult && !!attack.isCrit,
      isFumble: !hideResult && !!attack.isFumble,
      attackManual: !!attack.manual,
      formula: this.#damageFormulaDisplay(),
      situational: entry.damageSituational,
      manual: this.manualDamage,
      manualDamageValue: entry.manualDamageValue,
      damage: entry.damage
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    Hooks.on("targetToken", this.#onUserRetarget);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;

    el.querySelector('[name="situational"]')?.addEventListener("input", ev => {
      const entry = this.current;
      if (this.phase === "attack") entry.situational = ev.target.value;
      else entry.damageSituational = ev.target.value;
      this.#refreshFormulaDisplay();
    });

    el.querySelector('[name="rollMode"]')?.addEventListener("change", ev => {
      this.rollMode = ev.target.value;
      this.render(); // show/hide the whisper recipient list
    });

    el.querySelector('[name="attackMode"]')?.addEventListener("change", ev => {
      this.current.attackMode = ev.target.value;
      this.#refreshFormulaDisplay();
    });

    el.querySelectorAll("[data-whisper-id]").forEach(box => box.addEventListener("change", ev => {
      const id = ev.target.dataset.whisperId;
      if (ev.target.checked) this.whisperIds.add(id);
      else this.whisperIds.delete(id);
    }));

    el.querySelector('[name="manualValue"]')?.addEventListener("input", ev => {
      this.current.manualValue = ev.target.value;
      this.#refreshManualTotal();
    });

    el.querySelector('[name="manualDamageValue"]')?.addEventListener("input", ev => {
      this.current.manualDamageValue = ev.target.value;
    });
  }

  #refreshFormulaDisplay() {
    const node = this.element?.querySelector(".bc-formula");
    if (!node) return;
    node.textContent = this.phase === "attack"
      ? this.#attackFormulaDisplay()
      : this.#damageFormulaDisplay();
    this.#refreshManualTotal();
  }

  #refreshManualTotal() {
    const node = this.element?.querySelector(".bc-manual-total");
    if (node) node.textContent = this.#manualAttackTotalDisplay();
  }

  /* -------------------------------------------- */
  /*  Formula display (cosmetic only — §11)       */
  /* -------------------------------------------- */

  #attackFormulaDisplay() {
    const entry = this.current;
    const d20 = entry.advMode === 1 ? "2d20kh" : entry.advMode === -1 ? "2d20kl" : "1d20";
    const parts = [d20];
    const toHit = parseToHit(this.activity);
    const toHitLabel = (this.activity?.labels?.toHit ?? "").replace(/\s+/g, "");
    if (toHit !== null) parts.push(String(Math.abs(toHit)));
    else if (toHitLabel) parts.push(toHitLabel.replace(/^[+]/, ""));
    let formula = toHit !== null && toHit < 0
      ? `${parts[0]} - ${parts[1]}`
      : parts.join(" + ");
    const bonus = normalizeBonus(entry.situational);
    if (bonus) formula += bonus.startsWith("-") ? ` - ${bonus.slice(1)}` : ` + ${bonus}`;
    return formula;
  }

  #damageFormulaDisplay() {
    let display = "";
    try {
      const config = this.activity.getDamageConfig?.({});
      const RollCls = getRollClass();
      const simplify = dnd5eApi()?.dice?.simplifyRollFormula;
      display = (config?.rolls ?? []).map(r => {
        let f = (r.parts ?? []).join(" + ");
        try { f = RollCls.replaceFormulaData(f, r.data ?? {}); } catch (e) { /* keep raw */ }
        try { f = simplify?.(f) ?? f; } catch (e) { /* keep unsimplified */ }
        const type = r.options?.types?.first?.() ?? [...(r.options?.types ?? [])][0] ?? r.options?.type;
        const label = type ? game.i18n.localize(CONFIG.DND5E?.damageTypes?.[type]?.label ?? type) : null;
        return label ? `${f} [${label}]` : f;
      }).filter(Boolean).join(" + ");
    } catch (e) {
      warn("Damage formula display failed", e);
    }
    if (!display) display = this.activity?.labels?.damage ?? "";
    const { untyped, typed } = parseTypedBonus(this.current.damageSituational);
    if (untyped) display += untyped.startsWith("-") ? ` - ${untyped.slice(1)}` : ` + ${untyped}`;
    for (const bonus of typed) display += ` + ${bonus.formula} [${damageTypeLabel(bonus.type)}]`;
    return display;
  }

  #manualAttackTotalDisplay() {
    const entry = this.current;
    const face = Number(entry.manualValue);
    if (!Number.isInteger(face) || face < 1) return "";
    const toHit = parseToHit(this.activity) ?? 0;
    let total = face + toHit;
    const bonus = normalizeBonus(entry.situational);
    let suffix = "";
    if (bonus && isNumericBonus(bonus)) total += Number(bonus.replace(/\s+/g, ""));
    else if (bonus) suffix = ` + ${bonus}`;
    return `= ${total}${suffix}`;
  }

  /* -------------------------------------------- */
  /*  Attack rolling                              */
  /* -------------------------------------------- */

  async #performAttackRoll() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (this.rollMode === "whisper" && !this.whisperIds.size) {
        ui.notifications.warn(game.i18n.localize("BATTLECARD.Notifications.WhisperNoTargets"));
        return;
      }
      const entry = this.current;
      const attack = this.manualAttack
        ? await this.#manualAttackResult(entry)
        : await this.#systemAttackRoll(entry);
      if (!attack) return; // invalid input or roll cancelled
      entry.attack = attack;
      this.phase = "damage";          // auto-advance; no hit/miss question
      this.manualDamage = false;
      await this.#syncCard();
      this.render();
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Roll through the dnd5e system machinery with its dialog suppressed and
   * message creation disabled (we own the chat card). A short-lived
   * preRollAttack hook injects advantage state and the situational bonus into
   * the authoritative roll configuration.
   */
  async #systemAttackRoll(entry) {
    const activity = this.activity;
    const ADV = advModes();
    const bonus = normalizeBonus(entry.situational);
    const advMode = entry.advMode;

    const mutate = config => {
      try {
        if (config?.subject && config.subject !== activity) return;
        if (advMode === 1) { config.advantage = true; config.disadvantage = false; }
        else if (advMode === -1) { config.disadvantage = true; config.advantage = false; }
        for (const r of config?.rolls ?? []) {
          if (bonus) {
            r.parts ??= [];
            r.parts.push(bonus);
          }
          r.options ??= {};
          if (advMode === 1) r.options.advantageMode = ADV.ADVANTAGE;
          else if (advMode === -1) r.options.advantageMode = ADV.DISADVANTAGE;
        }
      } catch (e) {
        warn("preRollAttack mutation failed", e);
      }
    };

    // advantage/disadvantage also go in the direct config — the officially
    // merged path (AttackActivity#rollAttack mergeObject; D20Roll reads
    // config.advantage when no keyboard event is present). The hook below
    // additionally injects the situational bonus parts.
    const processConfig = {};
    if (advMode === 1) processConfig.advantage = true;
    else if (advMode === -1) processConfig.disadvantage = true;
    if (entry.attackMode) processConfig.attackMode = entry.attackMode;

    Hooks.on("dnd5e.preRollAttack", mutate);
    let rolls;
    try {
      rolls = await activity.rollAttack(processConfig, { configure: false }, { create: false });
    } catch (e) {
      warn("System attack roll failed", e);
      ui.notifications.error(game.i18n.localize("BATTLECARD.Notifications.RollFailed"));
      return null;
    } finally {
      Hooks.off("dnd5e.preRollAttack", mutate);
    }
    if (!rolls?.length) return null;

    const roll = rolls[0];
    const d20 = roll.dice?.find(d => d.faces === 20);
    const face = d20?.results?.find(r => r.active)?.result ?? null;
    await showDice(roll, this.rollMode, [...this.whisperIds]);
    return {
      total: roll.total,
      d20: face,
      isCrit: roll.isCritical ?? face === 20,
      isFumble: roll.isFumble ?? face === 1,
      manual: false,
      formula: roll.formula,
      rollHTML: await this.#renderRoll(roll)
    };
  }

  /**
   * Manual physical-dice entry: the raw d20 face is required (nat 20/1
   * detection); the total is computed from the formula's modifiers. Dice in
   * the situational bonus are still rolled digitally and added.
   */
  async #manualAttackResult(entry) {
    const face = Number(entry.manualValue);
    if (!Number.isInteger(face) || face < 1 || face > 20) {
      ui.notifications.warn(game.i18n.localize("BATTLECARD.Notifications.InvalidD20"));
      return null;
    }
    const toHit = parseToHit(this.activity) ?? 0;
    let total = face + toHit;
    const bonus = normalizeBonus(entry.situational);
    if (bonus) {
      if (isNumericBonus(bonus)) total += Number(bonus.replace(/\s+/g, ""));
      else {
        try {
          const RollCls = getRollClass();
          const bonusRoll = await new RollCls(bonus, this.activity?.getRollData?.() ?? {}).evaluate();
          total += bonusRoll.total;
        } catch (e) {
          warn(`Could not evaluate situational bonus "${bonus}"`, e);
        }
      }
    }
    return {
      total,
      d20: face,
      isCrit: face === 20,
      isFumble: face === 1,
      manual: true,
      formula: null,
      rollHTML: null
    };
  }

  /* -------------------------------------------- */
  /*  Damage rolling                              */
  /* -------------------------------------------- */

  async #performDamageRoll({ critical }) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const entry = this.current;
      const damage = this.manualDamage
        ? this.#manualDamageResult(entry, critical)
        : await this.#systemDamageRoll(entry, critical);
      if (!damage) return;
      entry.damage = damage;
      this.phase = "post";
      await this.#syncCard();
      this.render();
    } finally {
      this.#busy = false;
    }
  }

  async #systemDamageRoll(entry, critical) {
    const activity = this.activity;
    // Typed bonus damage (e.g. "1d6 fire, 1d8 psychic, +2"): typed entries
    // become their own damage parts so resistances apply per type; untyped
    // remainder folds into the first part.
    const { untyped, typed } = parseTypedBonus(entry.damageSituational);

    const mutate = config => {
      try {
        if (config?.subject && config.subject !== activity) return;
        config.isCritical = critical;
        const rolls = config?.rolls ?? [];
        for (const r of rolls) {
          r.options ??= {};
          r.options.isCritical = critical;
        }
        if (untyped && rolls[0]) {
          rolls[0].parts ??= [];
          rolls[0].parts.push(untyped);
        }
        const data = rolls[0]?.data ?? activity.getRollData?.() ?? {};
        for (const bonus of typed) {
          rolls.push({
            parts: [bonus.formula],
            data,
            options: { type: bonus.type, isCritical: critical }
          });
        }
        config.rolls = rolls;
      } catch (e) {
        warn("preRollDamage mutation failed", e);
      }
    };

    Hooks.on("dnd5e.preRollDamage", mutate);
    let rolls;
    try {
      const processConfig = { isCritical: critical };
      if (entry.attackMode) processConfig.attackMode = entry.attackMode;
      rolls = await activity.rollDamage(processConfig, { configure: false }, { create: false });
    } catch (e) {
      warn("System damage roll failed", e);
      ui.notifications.error(game.i18n.localize("BATTLECARD.Notifications.RollFailed"));
      return null;
    } finally {
      Hooks.off("dnd5e.preRollDamage", mutate);
    }
    if (!rolls?.length) return null;

    for (const r of rolls) await showDice(r, this.rollMode, [...this.whisperIds]);
    const total = rolls.reduce((t, r) => t + (r.total ?? 0), 0);
    const parts = rolls.map(r => ({
      amount: r.total ?? 0,
      type: r.options?.type ?? null,
      properties: [...(r.options?.properties ?? [])]
    }));
    const typeLabel = this.#damageTypesLabel(rolls);
    const html = (await Promise.all(rolls.map(r => this.#renderRoll(r)))).join("");
    return {
      total,
      parts,
      typeLabel,
      critical,
      manual: false,
      miss: false,
      rollHTML: html
    };
  }

  /**
   * Manual physical-dice damage: "14" or typed totals "10 slashing, 4 fire".
   * Untyped segments take the weapon's primary damage type so Apply Damage
   * can still respect resistances.
   */
  #manualDamageResult(entry, critical) {
    const parsed = parseTypedManualDamage(entry.manualDamageValue);
    if (!parsed) {
      ui.notifications.warn(game.i18n.localize("BATTLECARD.Notifications.InvalidDamage"));
      return null;
    }
    const fallbackType = this.#firstDamageTypeKey();
    const parts = parsed.map(p => ({ amount: p.amount, type: p.type ?? fallbackType, properties: [] }));
    const types = [...new Set(parts.map(p => p.type).filter(Boolean))];
    return {
      total: parts.reduce((t, p) => t + p.amount, 0),
      parts,
      typeLabel: types.map(damageTypeLabel).join(", "),
      critical,
      manual: true,
      miss: false,
      rollHTML: null
    };
  }

  #markMiss() {
    this.current.damage = { miss: true };
    this.phase = "post";
  }

  #damageTypesLabel(rolls) {
    const types = [...new Set(rolls.map(r => r.options?.type).filter(Boolean))];
    return types
      .map(t => game.i18n.localize(CONFIG.DND5E?.damageTypes?.[t]?.label ?? t))
      .join(", ");
  }

  #firstDamageTypeKey() {
    try {
      const config = this.activity.getDamageConfig?.({});
      const r = config?.rolls?.[0];
      return r?.options?.types?.first?.() ?? [...(r?.options?.types ?? [])][0] ?? r?.options?.type ?? null;
    } catch (e) {
      return null;
    }
  }

  async #renderRoll(roll) {
    try {
      return await roll.render();
    } catch (e) {
      return null;
    }
  }

  /* -------------------------------------------- */
  /*  Consumption notice                          */
  /* -------------------------------------------- */

  /**
   * Battlecard suppresses the system usage dialog — the place consumption is
   * normally visible — so resource costs are surfaced here instead.
   * Consumption is applied by the system at activation, before this dialog
   * opens, hence the past tense. Display only; never alters behavior.
   */
  #consumptionNotice() {
    try {
      const targets = this.activity?.consumption?.targets ?? [];
      if (!targets.length) return null;
      const described = targets.map(t => this.#describeConsumption(t)).filter(Boolean);
      if (!described.length) return null;
      return game.i18n.format("BATTLECARD.Dialog.ConsumedOnUse", { what: described.join(", ") });
    } catch (e) {
      return null;
    }
  }

  #describeConsumption(target) {
    const value = target?.value ?? 1;
    switch (target?.type) {
      case "itemUses":
        return game.i18n.format("BATTLECARD.Consumption.ItemUses", { value });
      case "activityUses":
        return game.i18n.format("BATTLECARD.Consumption.ActivityUses", { value });
      case "spellSlots":
        return game.i18n.format("BATTLECARD.Consumption.SpellSlots", { value });
      case "material": {
        const name = this.actor?.items?.get(target.target)?.name
          ?? game.i18n.localize("BATTLECARD.Consumption.MaterialFallback");
        return game.i18n.format("BATTLECARD.Consumption.Material", { value, name });
      }
      case "hitDice":
        return game.i18n.format("BATTLECARD.Consumption.HitDice", { value });
      case "attribute":
        return game.i18n.format("BATTLECARD.Consumption.Attribute", { value, attribute: target.target ?? "?" });
      default:
        return `${value} ${target?.type ?? "?"}`;
    }
  }

  /* -------------------------------------------- */
  /*  Whisper & target helpers                    */
  /* -------------------------------------------- */

  /** Selectable whisper recipients: every other user, inactive ones dimmed. */
  #whisperTargets() {
    return game.users.contents
      .filter(u => !u.isSelf)
      .map(u => ({ id: u.id, name: u.name, active: u.active, checked: this.whisperIds.has(u.id) }));
  }

  /**
   * Target deleted or off-scene mid-sequence (§11): warn but let the
   * sequence proceed — rolls never depend on the target.
   */
  #targetMissing(entry) {
    const uuid = entry?.target?.uuid;
    if (!uuid) return false;
    try {
      return !fromUuidSyncCompat(uuid)?.object;
    } catch (e) {
      return true;
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onSetAdvantage(event, target) {
    this.current.advMode = Number(target.dataset.adv ?? 0);
    this.render();
  }

  static #onToggleManual() {
    if (this.phase === "attack") this.manualAttack = !this.manualAttack;
    else this.manualDamage = !this.manualDamage;
    this.render();
  }

  static #onChangeTarget() {
    if (this.#cancelPick) return;
    this.minimize();
    this.#cancelPick = startTargetPick({
      onPick: token => {
        this.#cancelPick = null;
        this.current.target = snapshotToken(token);
        this.current.multipleTargets = false;
        this.maximize();
        this.render();
      },
      onCancel: () => {
        this.#cancelPick = null;
        this.maximize();
      }
    });
  }

  static #onNoTarget() {
    // First-class option: proceed untargeted (§4). Does not touch the user's
    // actual native target set — only this sequence's recorded target.
    this.current.target = null;
    this.current.multipleTargets = false;
    this.render();
  }

  static async #onRollAttack() {
    await this.#performAttackRoll();
  }

  static async #onRollDamage() {
    await this.#performDamageRoll({ critical: false });
  }

  static async #onRollCritical() {
    await this.#performDamageRoll({ critical: true });
  }

  static async #onMiss() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      this.#markMiss();
      await this.#syncCard();
      this.render();
    } finally {
      this.#busy = false;
    }
  }

  static async #onDone() {
    this.#finished = true;
    this.phase = "post";
    await this.#syncCard();
    autoClearTargets();
    this.close();
  }

  static #onAttackAgain() {
    // Same item; current native target pre-loaded but fully changeable.
    this.#pushNewAttack();
    this.phase = "attack";
    this.manualAttack = false;
    this.render();
  }

  /* -------------------------------------------- */
  /*  Closing                                     */
  /* -------------------------------------------- */

  _onClose(options) {
    super._onClose?.(options);
    Hooks.off("targetToken", this.#onUserRetarget);
    this.#cancelPick?.();
    this.#cancelPick = null;
    try {
      const { left, top } = this.position;
      if (Number.isFinite(left) && Number.isFinite(top)) {
        game.settings.set(MODULE_ID, "dialogPosition", { left, top });
      }
    } catch (e) { /* settings not ready */ }
    if (BattlecardDialog.current === this) BattlecardDialog.current = null;
    // Closing mid-sequence does NOT cancel the sequence (§7): the card keeps
    // its state in flags and re-renders locally to surface its Resume button.
    if (!this.#finished && this.#message) {
      refreshMessageDisplay(this.#message);
      log(`Sequence on message ${this.#message.id} abandoned (resumable from card).`);
    }
  }
}
