import {
  MODULE_ID, advModes, dnd5eApi, firstTarget, getRollClass, isNumericBonus, log,
  normalizeBonus, parseToHit, rollModeOptions, showDice, snapshotToken, targetCount, warn
} from "./util.js";
import { initialRollMode } from "./settings.js";
import { createSequenceMessage, updateSequenceMessage } from "./chat-card.js";
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
    this.phase = "attack";
    this.rollMode = initialRollMode();
    this.manualAttack = false;
    this.manualDamage = false;
    this.sequence = { attacks: [] };
    this.#pushNewAttack();
  }

  /** @type {BattlecardDialog|null} The one open dialog on this client. */
  static current = null;

  #message = null;       // the evolving ChatMessage for this sequence
  #finished = false;     // Done was pressed
  #cancelPick = null;    // active pick-mode canceller
  #busy = false;         // roll in flight; ignore re-clicks

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

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */

  /** Open the dialog for an attack activity, replacing any prior instance. */
  static async open(activity) {
    if (BattlecardDialog.current) {
      try { await BattlecardDialog.current.close(); } catch (e) { /* already closed */ }
    }
    const options = { activity };
    const pos = game.settings.get(MODULE_ID, "dialogPosition");
    if (Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
      options.position = { left: pos.left, top: pos.top };
    }
    const dialog = new BattlecardDialog(options);
    BattlecardDialog.current = dialog;
    dialog.render(true);
    return dialog;
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
      situational: "",
      damageSituational: "",
      manualValue: "",
      manualDamageValue: "",
      attack: null,
      damage: null
    });
  }

  /** Serializable sequence state stored in the chat card's flags (§6). */
  #buildState() {
    return {
      version: 1,
      ownerUserId: game.user.id,
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
        multipleTargets: entry.multipleTargets,
        isAdv: entry.advMode === 1,
        isNormal: entry.advMode === 0,
        isDis: entry.advMode === -1,
        formula: this.#attackFormulaDisplay(),
        situational: entry.situational,
        rollModes: rollModeOptions(this.rollMode),
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
    });

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
    const bonus = normalizeBonus(this.current.damageSituational);
    if (bonus) display += bonus.startsWith("-") ? ` - ${bonus.slice(1)}` : ` + ${bonus}`;
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

    Hooks.on("dnd5e.preRollAttack", mutate);
    let rolls;
    try {
      rolls = await activity.rollAttack({}, { configure: false }, { create: false });
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
    await showDice(roll, this.rollMode);
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
    const bonus = normalizeBonus(entry.damageSituational);

    const mutate = config => {
      try {
        if (config?.subject && config.subject !== activity) return;
        config.isCritical = critical;
        const rolls = config?.rolls ?? [];
        for (const r of rolls) {
          r.options ??= {};
          r.options.isCritical = critical;
        }
        // Situational damage applies once, to the first damage part.
        if (bonus && rolls[0]) {
          rolls[0].parts ??= [];
          rolls[0].parts.push(bonus);
        }
      } catch (e) {
        warn("preRollDamage mutation failed", e);
      }
    };

    Hooks.on("dnd5e.preRollDamage", mutate);
    let rolls;
    try {
      rolls = await activity.rollDamage({ isCritical: critical }, { configure: false }, { create: false });
    } catch (e) {
      warn("System damage roll failed", e);
      ui.notifications.error(game.i18n.localize("BATTLECARD.Notifications.RollFailed"));
      return null;
    } finally {
      Hooks.off("dnd5e.preRollDamage", mutate);
    }
    if (!rolls?.length) return null;

    for (const r of rolls) await showDice(r, this.rollMode);
    const total = rolls.reduce((t, r) => t + (r.total ?? 0), 0);
    const typeLabel = this.#damageTypesLabel(rolls);
    const html = (await Promise.all(rolls.map(r => this.#renderRoll(r)))).join("");
    return {
      total,
      typeLabel,
      critical,
      manual: false,
      miss: false,
      rollHTML: html
    };
  }

  #manualDamageResult(entry, critical) {
    const total = Number(entry.manualDamageValue);
    if (!Number.isFinite(total) || total < 0) {
      ui.notifications.warn(game.i18n.localize("BATTLECARD.Notifications.InvalidDamage"));
      return null;
    }
    return {
      total,
      typeLabel: this.#firstDamageTypeLabel(),
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

  #firstDamageTypeLabel() {
    try {
      const config = this.activity.getDamageConfig?.({});
      const r = config?.rolls?.[0];
      const type = r?.options?.types?.first?.() ?? [...(r?.options?.types ?? [])][0] ?? r?.options?.type;
      return type ? game.i18n.localize(CONFIG.DND5E?.damageTypes?.[type]?.label ?? type) : "";
    } catch (e) {
      return "";
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
    this.#cancelPick?.();
    this.#cancelPick = null;
    try {
      const { left, top } = this.position;
      if (Number.isFinite(left) && Number.isFinite(top)) {
        game.settings.set(MODULE_ID, "dialogPosition", { left, top });
      }
    } catch (e) { /* settings not ready */ }
    if (BattlecardDialog.current === this) BattlecardDialog.current = null;
    // Closing mid-sequence does NOT cancel the sequence: the card keeps its
    // state in flags. (Resume button lands in M2.)
    if (!this.#finished && this.#message) {
      log(`Sequence on message ${this.#message.id} left open (resumable state saved).`);
    }
  }
}
