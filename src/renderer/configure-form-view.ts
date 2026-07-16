// The interactive Configure form: builds the field DOM inside #form-view, binds it to a ManifestFormModel
// and converts to/from game.json TEXT via the pure configure-form-model (the single source of truth stays
// the text — see plan R2). This module owns only the FORM's DOM + state (rest/corrupt kept across the
// round-trip); the shared shell (drive picker, tabs, Save/Reset, status, issues panel, JSON editor) and
// the validation/dirty/save wiring live in configure.ts.
//
// The form is split into SECTIONS (Basics/Launch/Hero/Saves/Audio/Advanced); configure.ts renders a tab
// bar and shows one section panel at a time via showSection(). Fluent components used here
// (switch/text-input/dropdown/listbox/option/button) are registered in configure.ts. Labels come from the
// translator and are re-applied on a language change via applyLabels().
import {
  formModelToText,
  textToFormModel,
  type InstallType,
  type InstallerFamily,
  type LaunchMode,
  type ManifestFormModel,
  type ParseFormResult,
} from './configure-form-model.js';
import type { ConfigPickKind, ConfigPickResult, ManifestValidationIssue } from '../shared/types';
import type { Translator } from '../shared/i18n/index';
import type { MessageKey } from '../shared/i18n/en';

type ValueEl = HTMLElement & { value?: string };
type CheckedEl = HTMLElement & { checked?: boolean };

function getValue(el: ValueEl): string {
  return typeof el.value === 'string' ? el.value : '';
}
function getChecked(el: CheckedEl): boolean {
  return el.checked === true;
}

/** Where the SteamDB appid lookup opens (the #7 helper link). */
const STEAMDB_URL = 'https://steamdb.info/';

/** The form's section ids (each a tab / a panel shown one at a time). */
export type SectionId = 'basics' | 'launch' | 'hero' | 'saves' | 'audio' | 'advanced';

/** Section descriptors, consumed by configure.ts to build the tab bar (label = section heading). */
export const FORM_SECTIONS: ReadonlyArray<{ readonly id: SectionId; readonly labelKey: MessageKey }> = [
  { id: 'basics', labelKey: 'configure.sectionBasics' },
  { id: 'launch', labelKey: 'configure.sectionLaunch' },
  { id: 'hero', labelKey: 'configure.sectionHero' },
  { id: 'saves', labelKey: 'configure.sectionSaves' },
  { id: 'audio', labelKey: 'configure.sectionAudio' },
  { id: 'advanced', labelKey: 'configure.sectionAdvanced' },
];

export interface FormViewDeps {
  /** The form container (#form-view). */
  readonly root: HTMLElement;
  /** Live translator (re-read on a language push). */
  readonly translator: () => Translator;
  /** A field changed → the owner re-serializes, validates and marks dirty. */
  readonly onChange: () => void;
  /** Pick file(s)/a folder for a Browse… button (root is closed over in configure.ts). */
  readonly pickPath: (kind: ConfigPickKind, gameId?: string) => Promise<ConfigPickResult>;
  /** Read a card-relative image into a data URL for a hero thumbnail (null when unreadable). */
  readonly imagePreview: (relative: string) => Promise<string | null>;
  /** Open an external https URL (the appid helper link). */
  readonly openExternal: (url: string) => void;
  /** Surface a picker rejection message in the status line. */
  readonly onPickError: (message: string) => void;
}

/** All error slots the form can address; an issue path maps onto one of these keys (else it is unmapped
 * and returned to the owner for the #issues panel). */
type FieldKey =
  | 'id'
  | 'title'
  | 'executable'
  | 'args'
  | 'runAsAdmin'
  | 'watchProcesses'
  | 'heroImage'
  | 'saveOnCard'
  | 'pcSavePath'
  | 'backgroundMusic'
  | 'winetricks'
  | 'umuGameId'
  | 'launchTimeoutSec'
  | 'killTimeoutSec'
  | 'steam.appid'
  // The "move game to PC" switch and its source-directory field. They emit the same `install.installer`
  // path as Installer mode does, but need slots of their OWN: sharing 'install.installer' would make the
  // two modes' error slots overwrite each other in `errorEls`, and an error routed to the hidden
  // Installer section would block Save with nothing on screen to explain why (see fieldKeyForPath).
  | 'copyToPc'
  | 'copySource'
  | 'install.installer'
  | 'install.type'
  | 'install.runAsAdmin'
  | 'install.args'
  | 'install.winetricks'
  | 'sounds.play'
  | 'sounds.navigate'
  | 'sounds.button'
  | 'sounds.back';

/** A dynamic string list (args / watchProcesses / heroImage / install.args): a stack of rows + Add. */
interface DynamicList {
  readonly wrapper: HTMLElement;
  values(): string[];
  setValues(values: readonly string[]): void;
  setDisabled(disabled: boolean): void;
}

/** An audio field with a Default/Custom selector (Default → empty → omitted from game.json). */
interface AudioField {
  readonly wrapper: HTMLElement;
  readonly input: ValueEl;
  setValue(value: string): void;
  setDisabled(disabled: boolean): void;
}

export class FormView {
  private readonly deps: FormViewDeps;

  // Per-field controls.
  private readonly idInput: ValueEl;
  private readonly titleInput: ValueEl;
  private readonly launchType: ValueEl;
  private readonly executableInput: ValueEl;
  private readonly runAsAdminSwitch: CheckedEl;
  private readonly copyToPcSwitch: CheckedEl;
  private readonly copySourceInput: ValueEl;
  private readonly installInstallerInput: ValueEl;
  private readonly installType: ValueEl;
  private readonly installRunAsAdminSwitch: CheckedEl;
  private readonly appidInput: ValueEl;
  private readonly saveOnCardInput: ValueEl;
  private readonly pcSavePathInput: ValueEl;
  private readonly soundPlay: AudioField;
  private readonly soundNavigate: AudioField;
  private readonly soundButton: AudioField;
  private readonly soundBack: AudioField;
  private readonly music: AudioField;
  private readonly launchTimeoutInput: ValueEl;
  private readonly killTimeoutInput: ValueEl;

  private readonly argsList: DynamicList;
  private readonly watchList: DynamicList;
  private readonly heroList: DynamicList;
  private readonly installArgsList: DynamicList;
  private readonly installWinetricksList: DynamicList;
  private readonly gameWinetricksList: DynamicList;
  private readonly umuGameIdInput: ValueEl;

  // Section wrappers toggled by the launch mode.
  private readonly execSection: HTMLElement;
  private readonly installSection: HTMLElement;
  private readonly steamSection: HTMLElement;
  /** The copy-source field — inside execSection, shown only while the "move to PC" switch is on. */
  private readonly copySourceField: HTMLElement;
  /** Note under `executable`: says what the path is relative to (it changes with the copy switch). */
  private readonly executableNote: HTMLElement;

  private readonly mixedBanner: HTMLElement;
  private readonly sectionPanels = new Map<SectionId, HTMLElement>();

  // Error / label / container registries.
  private readonly errorEls = new Map<FieldKey, HTMLElement>();
  private readonly containers = new Map<string, HTMLElement>(); // by corrupt key (top-level)
  private readonly labelRefs: Array<{ el: HTMLElement; key: MessageKey }> = [];
  private readonly optionRefs: Array<{ el: HTMLElement; key: MessageKey }> = [];
  private readonly placeholderRefs: Array<{ el: ValueEl; key: MessageKey }> = [];

  // View state.
  private launchMode: LaunchMode = 'executable';
  private rest: Readonly<Record<string, unknown>> = {};
  // Unknown keys nested inside the sounds/install/steam blocks: the form has no field for them, so they
  // must be remembered from load() and put back in readModel() (else serialize() drops them — the blocks'
  // zod is strip-mode, so the loss would be silent). Mirrors the top-level `rest` round-trip.
  private soundsRest: Readonly<Record<string, unknown>> = {};
  private installRest: Readonly<Record<string, unknown>> = {};
  /** The copy slot's own unknown keys — kept apart from installRest, like the two slots themselves. */
  private copyInstallRest: Readonly<Record<string, unknown>> = {};
  /** The copy slot's `winetricks`: valid for copy (the prefix IS provisioned) but with no control of its
   * own — the form only offers the source directory. Remembered so a hand-written value survives Save. */
  private copyInstallWinetricks: readonly string[] = [];
  private steamRest: Readonly<Record<string, unknown>> = {};
  private corrupt: Record<string, unknown> = {};
  private mixed = false;

  constructor(deps: FormViewDeps) {
    this.deps = deps;

    this.mixedBanner = document.createElement('div');
    this.mixedBanner.id = 'mixed-banner';
    this.mixedBanner.hidden = true;

    // ── Basics ──────────────────────────────────────────────────────────────
    this.idInput = this.textInput('id');
    this.titleInput = this.textInput('title');
    const schemaLine = document.createElement('div');
    schemaLine.className = 'field-static';
    this.labelRefs.push({ el: schemaLine, key: 'configure.schemaVersion' });
    this.addSection('basics', [
      this.field('configure.fieldId', 'id', this.idInput),
      this.field('configure.fieldTitle', 'title', this.titleInput),
      schemaLine,
    ]);

    // ── Launch ──────────────────────────────────────────────────────────────
    this.launchType = this.dropdown([
      ['executable', 'configure.launchExecutable'],
      ['installer', 'configure.launchInstaller'],
      ['steam', 'Steam'], // brand — literal, not a dictionary key
    ]);
    this.launchType.addEventListener('change', () => this.onLaunchTypeChange());

    this.executableInput = this.textInput('executable');
    this.argsList = this.dynamicList('args', 'configure.fieldArgs', { reorder: true });
    this.runAsAdminSwitch = this.switchControl('runAsAdmin');
    this.copyToPcSwitch = this.switchControl('copyToPc');
    this.copyToPcSwitch.addEventListener('change', () => this.onCopyToPcChange());
    this.copySourceInput = this.textInput('copySource');
    this.copySourceField = this.fieldWithBrowse(
      'configure.fieldCopySource',
      'copySource',
      this.copySourceInput,
      'directory',
    );
    const copySourceHint = document.createElement('div');
    copySourceHint.className = 'field-hint';
    this.labelRefs.push({ el: copySourceHint, key: 'configure.copySourceHint' });
    this.copySourceField.append(copySourceHint);
    // The executable's meaning depends on the switch (card root vs the copied directory), so its note
    // lives with the switch's field and is re-worded in updateCopyToPcState.
    const execField = this.fieldWithBrowse(
      'configure.fieldExecutable',
      'executable',
      this.executableInput,
      'executable',
      (picked) => this.executableFromPick(picked),
    );
    this.executableNote = document.createElement('div');
    this.executableNote.className = 'field-hint';
    execField.append(this.executableNote);
    this.execSection = this.group([
      execField,
      this.argsList.wrapper,
      this.switchField('configure.fieldRunAsAdmin', 'runAsAdmin', this.runAsAdminSwitch),
      this.switchField('configure.fieldCopyToPc', 'copyToPc', this.copyToPcSwitch),
      this.copySourceField,
    ]);

    this.installInstallerInput = this.textInput('install');
    this.installType = this.dropdown([
      ['nsis', 'NSIS'],
      ['inno', 'Inno'],
      ['custom', 'Custom'],
    ]);
    this.installType.addEventListener('change', () => this.onInstallTypeChange());
    this.installRunAsAdminSwitch = this.switchControl('install');
    this.installArgsList = this.dynamicList('install', 'configure.fieldInstallArgs', { reorder: true });
    const installArgsHint = document.createElement('div');
    installArgsHint.className = 'field-hint';
    this.labelRefs.push({ el: installArgsHint, key: 'configure.installArgsDirHint' });
    this.installArgsList.wrapper.append(installArgsHint);
    // Always shown, regardless of the CURRENT platform: Configure edits a CARD, and cards are typically
    // authored on Windows and played on the Deck — hiding this on Windows would hide it from exactly the
    // person who needs to read it.
    const installerLinuxWarning = document.createElement('div');
    installerLinuxWarning.className = 'field-hint';
    this.labelRefs.push({ el: installerLinuxWarning, key: 'configure.installerLinuxWarning' });
    this.installSection = this.group([
      this.fieldWithBrowse(
        'configure.fieldInstaller',
        'install.installer',
        this.installInstallerInput,
        'installer',
      ),
      this.field('configure.fieldInstallType', 'install.type', this.installType),
      this.switchField('configure.fieldRunAsAdmin', 'install.runAsAdmin', this.installRunAsAdminSwitch),
      this.installArgsList.wrapper,
      installerLinuxWarning,
    ]);

    this.appidInput = this.numberInput('steam');
    const appidHelp = document.createElement('a');
    appidHelp.className = 'help-link';
    appidHelp.href = '#';
    this.labelRefs.push({ el: appidHelp, key: 'configure.appidHelp' });
    appidHelp.addEventListener('click', (event) => {
      event.preventDefault();
      this.deps.openExternal(STEAMDB_URL);
    });
    const appidField = this.field('configure.fieldAppid', 'steam.appid', this.appidInput);
    appidField.append(appidHelp);
    this.steamSection = this.group([appidField]);

    this.watchList = this.dynamicList('watchProcesses', 'configure.fieldWatchProcesses');
    const watchHint = document.createElement('div');
    watchHint.className = 'field-hint';
    this.labelRefs.push({ el: watchHint, key: 'configure.watchProcessesHint' });
    this.watchList.wrapper.append(watchHint);

    this.addSection('launch', [
      this.field('configure.launchType', null, this.launchType),
      this.execSection,
      this.installSection,
      this.steamSection,
      this.watchList.wrapper,
    ]);

    // ── Hero images (with thumbnails) ────────────────────────────────────────
    this.heroList = this.dynamicList('heroImage', 'configure.sectionHero', {
      browseKind: 'image',
      browseLabelKey: 'configure.addFile', // the bottom "Add…" button (multi-select adds rows)
      replaceKind: 'image', // each row gets a "Replace…" button to swap its file
      preview: true,
      reorder: true,
      noAdd: true,
    });
    this.addSection('hero', [this.heroList.wrapper]);

    // ── Saves ───────────────────────────────────────────────────────────────
    this.saveOnCardInput = this.textInput('saveOnCard');
    this.pcSavePathInput = this.textInput('pcSavePath');
    this.placeholderRefs.push({ el: this.pcSavePathInput, key: 'configure.pcSavePathPlaceholder' });
    this.addSection('saves', [
      this.fieldWithBrowse('configure.fieldSaveOnCard', 'saveOnCard', this.saveOnCardInput, 'directory'),
      // pcSavePath is an env-prefixed template (%APPDATA%\…). Its Browse picks a PC folder and main
      // converts it back to a %PREFIX%/… value (plan R6 was reversed per user request #3).
      this.fieldWithBrowse('configure.fieldPcSavePath', 'pcSavePath', this.pcSavePathInput, 'pc-save'),
    ]);

    // ── Audio (Default/Custom per slot) ──────────────────────────────────────
    this.soundPlay = this.audioField('configure.fieldSoundPlay', 'sounds.play', 'sounds', 'configure.soundBuiltinHint');
    this.soundNavigate = this.audioField('configure.fieldSoundNavigate', 'sounds.navigate', 'sounds', 'configure.soundBuiltinHint');
    this.soundButton = this.audioField('configure.fieldSoundButton', 'sounds.button', 'sounds', 'configure.soundBuiltinHint');
    this.soundBack = this.audioField('configure.fieldSoundBack', 'sounds.back', 'sounds', 'configure.soundBuiltinHint');
    this.music = this.audioField('configure.fieldBackgroundMusic', 'backgroundMusic', 'backgroundMusic', 'configure.musicNoneHint');
    this.addSection('audio', [
      this.soundPlay.wrapper,
      this.soundNavigate.wrapper,
      this.soundButton.wrapper,
      this.soundBack.wrapper,
      this.music.wrapper,
    ]);

    // ── Advanced ──────────────────────────────────────────────────────────────
    this.launchTimeoutInput = this.numberInput('launchTimeoutSec');
    this.killTimeoutInput = this.numberInput('killTimeoutSec');
    // Custom winetricks verbs (Linux/Proton, Р7b): added ON TOP of the app's baseline set, empty by
    // default. `game` verbs are provisioned before the game launches; `installer` verbs before the
    // installer runs. Share the install block's corrupt-clear (errorKey keeps a distinct error slot).
    this.gameWinetricksList = this.dynamicList('winetricks', 'configure.fieldWinetricks', { reorder: true });
    const gameWinetricksHint = document.createElement('div');
    gameWinetricksHint.className = 'field-hint';
    this.labelRefs.push({ el: gameWinetricksHint, key: 'configure.winetricksHint' });
    this.gameWinetricksList.wrapper.append(gameWinetricksHint);
    this.installWinetricksList = this.dynamicList('install', 'configure.fieldInstallWinetricks', {
      reorder: true,
      errorKey: 'install.winetricks',
    });
    const installWinetricksHint = document.createElement('div');
    installWinetricksHint.className = 'field-hint';
    this.labelRefs.push({ el: installWinetricksHint, key: 'configure.installWinetricksHint' });
    this.installWinetricksList.wrapper.append(installWinetricksHint);
    // umu GAMEID (Р7i): Steam appid or custom UMU_ID for the game's protonfix. A hint clarifies the value.
    this.umuGameIdInput = this.textInput('umuGameId');
    const umuGameIdField = this.field('configure.fieldUmuGameId', 'umuGameId', this.umuGameIdInput);
    const umuGameIdHint = document.createElement('div');
    umuGameIdHint.className = 'field-hint';
    this.labelRefs.push({ el: umuGameIdHint, key: 'configure.umuGameIdHint' });
    umuGameIdField.append(umuGameIdHint);
    this.addSection('advanced', [
      this.field('configure.fieldLaunchTimeout', 'launchTimeoutSec', this.launchTimeoutInput),
      this.field('configure.fieldKillTimeout', 'killTimeoutSec', this.killTimeoutInput),
      this.gameWinetricksList.wrapper,
      this.installWinetricksList.wrapper,
      umuGameIdField,
    ]);

    this.applyLabels();
    this.updateSectionVisibility();
    this.showSection('basics');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Shows one section panel (the tab bar in configure.ts drives this); hides the rest. */
  showSection(id: SectionId): void {
    for (const [sectionId, panel] of this.sectionPanels) panel.hidden = sectionId !== id;
  }

  /** Populates the form from a parsed manifest (or its constituents), remembering rest/corrupt. */
  load(
    model: ManifestFormModel,
    rest: Readonly<Record<string, unknown>>,
    corrupt: Readonly<Record<string, unknown>>,
    mixed: boolean,
  ): void {
    this.rest = rest;
    this.soundsRest = model.sounds.rest;
    this.installRest = model.install.rest;
    this.copyInstallRest = model.copyInstall.rest;
    this.steamRest = model.steam.rest;
    this.corrupt = { ...corrupt };
    this.launchMode = model.launchMode;
    this.launchType.value = model.launchMode;

    this.setScalar('id', this.idInput, model.id);
    this.setScalar('title', this.titleInput, model.title);
    this.setScalar('executable', this.executableInput, model.executable);
    this.setScalarChecked('runAsAdmin', this.runAsAdminSwitch, model.runAsAdmin);
    this.setScalar('saveOnCard', this.saveOnCardInput, model.saveOnCard);
    this.setScalar('pcSavePath', this.pcSavePathInput, model.pcSavePath);
    this.setScalar('launchTimeoutSec', this.launchTimeoutInput, model.launchTimeoutSec);
    this.setScalar('killTimeoutSec', this.killTimeoutInput, model.killTimeoutSec);

    this.setList('args', this.argsList, model.args);
    this.setList('watchProcesses', this.watchList, model.watchProcesses);
    this.setList('heroImage', this.heroList, model.heroImage);
    this.setList('winetricks', this.gameWinetricksList, model.winetricks);
    this.setScalar('umuGameId', this.umuGameIdInput, model.umuGameId);

    // install block (corrupt = whole block).
    const installCorrupt = 'install' in this.corrupt;
    this.installInstallerInput.value = installCorrupt ? '' : model.install.installer;
    this.installType.value = model.install.type;
    this.installRunAsAdminSwitch.checked = installCorrupt ? false : model.install.runAsAdmin;
    this.installArgsList.setValues(installCorrupt ? [] : model.install.args);
    this.installWinetricksList.setValues(installCorrupt ? [] : model.install.winetricks);
    this.updateInstallRunAsAdminState(model.install.type);

    // copy slot (the "move game to PC" checkbox — its own independent install block). A corrupt install
    // block belongs to Installer mode (the parse could not tell it was a copy one), hence the same guard.
    this.copyToPcSwitch.checked = installCorrupt ? false : model.copyToPc;
    this.copySourceInput.value = installCorrupt ? '' : model.copyInstall.installer;
    this.copyInstallWinetricks = model.copyInstall.winetricks;

    // steam block (corrupt = whole block).
    this.setScalar('steam', this.appidInput, model.steam.appid);

    // audio blocks (sounds corrupt = whole block; backgroundMusic is its own key).
    const soundsCorrupt = 'sounds' in this.corrupt;
    this.soundPlay.setValue(soundsCorrupt ? '' : model.sounds.play);
    this.soundNavigate.setValue(soundsCorrupt ? '' : model.sounds.navigate);
    this.soundButton.setValue(soundsCorrupt ? '' : model.sounds.button);
    this.soundBack.setValue(soundsCorrupt ? '' : model.sounds.back);
    this.music.setValue('backgroundMusic' in this.corrupt ? '' : model.backgroundMusic);

    this.mixed = mixed;
    this.updateSectionVisibility();
    this.renderMixedBanner();
    this.renderCorruptNotes();
  }

  /** Reads the current field values into a model and serializes to manifest text. */
  serialize(): string {
    return formModelToText(this.readModel(), this.rest, this.corrupt);
  }

  /** Maps validation issues onto inline field errors; returns the issues that did NOT map (for #issues). */
  setFieldErrors(issues: readonly ManifestValidationIssue[] | null): readonly ManifestValidationIssue[] {
    for (const el of this.errorEls.values()) el.textContent = '';
    if (issues === null) return [];
    const unmapped: ManifestValidationIssue[] = [];
    for (const issue of issues) {
      const key = fieldKeyForPath(issue.path, this.isCopyMode());
      const el = key !== null ? this.errorEls.get(key) : undefined;
      if (el === undefined) {
        unmapped.push(issue);
        continue;
      }
      el.textContent =
        el.textContent !== null && el.textContent !== '' ? `${el.textContent}; ${issue.message}` : issue.message;
    }
    return unmapped;
  }

  /** Enables/disables every control (blocked when the card is extracted). */
  setDisabled(disabled: boolean): void {
    const controls: HTMLElement[] = [
      this.idInput,
      this.titleInput,
      this.launchType,
      this.executableInput,
      this.runAsAdminSwitch,
      this.copyToPcSwitch,
      this.copySourceInput,
      this.installInstallerInput,
      this.installType,
      this.installRunAsAdminSwitch,
      this.appidInput,
      this.saveOnCardInput,
      this.pcSavePathInput,
      this.umuGameIdInput,
      this.launchTimeoutInput,
      this.killTimeoutInput,
      ...[...this.deps.root.querySelectorAll('.field-row fluent-button')].map((e) => e as HTMLElement),
    ];
    for (const el of controls) setElDisabled(el, disabled);
    for (const list of [
      this.argsList,
      this.watchList,
      this.heroList,
      this.installArgsList,
      this.installWinetricksList,
      this.gameWinetricksList,
    ]) {
      list.setDisabled(disabled);
    }
    for (const audio of [this.soundPlay, this.soundNavigate, this.soundButton, this.soundBack, this.music]) {
      audio.setDisabled(disabled);
    }
    // Keep the custom-installer rule even while enabling.
    if (!disabled) this.updateInstallRunAsAdminState(toInstallType(getValue(this.installType)));
  }

  /** Re-applies translator labels/placeholders (called on a language push). */
  relabel(): void {
    this.applyLabels();
    this.renderMixedBanner();
    this.renderCorruptNotes();
  }

  // ── Model read/write helpers ────────────────────────────────────────────────

  private readModel(): ManifestFormModel {
    return {
      launchMode: this.launchMode,
      id: getValue(this.idInput),
      title: getValue(this.titleInput),
      executable: getValue(this.executableInput),
      args: this.argsList.values(),
      runAsAdmin: getChecked(this.runAsAdminSwitch),
      watchProcesses: this.watchList.values(),
      winetricks: this.gameWinetricksList.values(),
      umuGameId: getValue(this.umuGameIdInput),
      heroImage: this.heroList.values(),
      saveOnCard: getValue(this.saveOnCardInput),
      pcSavePath: getValue(this.pcSavePathInput),
      launchTimeoutSec: getValue(this.launchTimeoutInput),
      killTimeoutSec: getValue(this.killTimeoutInput),
      sounds: {
        play: getValue(this.soundPlay.input),
        navigate: getValue(this.soundNavigate.input),
        button: getValue(this.soundButton.input),
        back: getValue(this.soundBack.input),
        rest: this.soundsRest,
      },
      backgroundMusic: getValue(this.music.input),
      install: {
        installer: getValue(this.installInstallerInput),
        type: toInstallType(getValue(this.installType)),
        runAsAdmin: getChecked(this.installRunAsAdminSwitch),
        args: this.installArgsList.values(),
        winetricks: this.installWinetricksList.values(),
        rest: this.installRest,
      },
      copyToPc: getChecked(this.copyToPcSwitch),
      // The copy slot has only the one control; `type` is pinned and the rest of the block round-trips
      // from what was loaded (its args/runAsAdmin are schema-forbidden, so they stay at the defaults).
      copyInstall: {
        installer: getValue(this.copySourceInput),
        type: 'copy',
        runAsAdmin: false,
        args: [],
        winetricks: this.copyInstallWinetricks,
        rest: this.copyInstallRest,
      },
      steam: { appid: getValue(this.appidInput), rest: this.steamRest },
    };
  }

  private setScalar(key: string, input: ValueEl, value: string): void {
    input.value = key in this.corrupt ? '' : value;
  }
  private setScalarChecked(key: string, input: CheckedEl, value: boolean): void {
    input.checked = key in this.corrupt ? false : value;
  }
  private setList(key: string, list: DynamicList, values: readonly string[]): void {
    list.setValues(key in this.corrupt ? [] : values);
  }

  // ── Corrupt / rest state ────────────────────────────────────────────────────

  // Clears a top-level corrupt key once the user edits that field (its value now comes from the model),
  // drops its "invalid value" note and re-runs onChange (via the caller).
  private clearCorrupt(key: string): void {
    if (key in this.corrupt) {
      const next = { ...this.corrupt };
      delete next[key];
      this.corrupt = next;
      this.renderCorruptNotes();
    }
  }

  // Renders the "field contains an invalid value" note under every still-corrupt field.
  private renderCorruptNotes(): void {
    const t = this.deps.translator();
    for (const [key, container] of this.containers) {
      const existing = container.querySelector('.corrupt-note');
      const corrupt = key in this.corrupt;
      if (corrupt && existing === null) {
        const note = document.createElement('div');
        note.className = 'field-hint corrupt-note';
        note.textContent = t('configure.corruptField');
        container.append(note);
      } else if (corrupt && existing !== null) {
        existing.textContent = t('configure.corruptField');
      } else if (!corrupt && existing !== null) {
        existing.remove();
      }
    }
  }

  private renderMixedBanner(): void {
    this.mixedBanner.hidden = !this.mixed;
    if (this.mixed) {
      this.mixedBanner.textContent = this.deps.translator()('configure.mixedLaunchModes', {
        mode: this.launchModeLabel(this.launchMode),
      });
    }
  }

  // The active mode's display label ("Steam" is a brand literal, the other two are translated).
  private launchModeLabel(mode: LaunchMode): string {
    if (mode === 'steam') return 'Steam';
    return this.deps.translator()(mode === 'installer' ? 'configure.launchInstaller' : 'configure.launchExecutable');
  }

  // ── Section visibility (launch mode) ─────────────────────────────────────────

  private onLaunchTypeChange(): void {
    const value = getValue(this.launchType);
    if (value === 'executable' || value === 'installer' || value === 'steam') {
      this.launchMode = value;
      this.updateSectionVisibility();
      this.deps.onChange();
    }
  }

  private onInstallTypeChange(): void {
    this.clearCorrupt('install');
    this.updateInstallRunAsAdminState(toInstallType(getValue(this.installType)));
    this.deps.onChange();
  }

  /** True while the form is in Executable mode with "move game to PC" on (manifest `install.type: copy`). */
  private isCopyMode(): boolean {
    return this.launchMode === 'executable' && getChecked(this.copyToPcSwitch);
  }

  private onCopyToPcChange(): void {
    this.clearCorrupt('install');
    this.updateCopyToPcState();
    this.deps.onChange();
  }

  // Shows the source field and re-words the executable's note: with the switch on, `executable` is
  // resolved inside the COPIED directory, not from the card root. The stored value is deliberately left
  // untouched — silently rewriting a path the user typed would be worse than telling them it changed
  // meaning (Browse does trim, where the intent is unambiguous — see executableFromPick).
  private updateCopyToPcState(): void {
    const copy = this.isCopyMode();
    this.copySourceField.hidden = !copy;
    this.executableNote.textContent = this.deps.translator()(
      copy ? 'configure.copyExecutableNote' : 'configure.executableNote',
    );
  }

  /**
   * Р14: the picker always returns paths relative to the CARD ROOT, but in copy mode `executable` is
   * relative to the copied directory — so a raw pick would silently produce a broken path
   * (`Games/Witcher/bin/witcher.exe` where the game will only have `bin/witcher.exe`). Trim the source
   * prefix; a pick from outside the source is a mistake we refuse rather than mangle.
   * Outside copy mode the pick passes through unchanged.
   */
  private executableFromPick(picked: string): string | null {
    if (!this.isCopyMode()) return picked;
    const source = getValue(this.copySourceInput).replace(/\/+$/, '');
    if (source === '') return picked; // no source yet → nothing to trim against
    const prefix = `${source}/`;
    if (!picked.startsWith(prefix)) {
      this.deps.onPickError(this.deps.translator()('configure.copySourceOutside', { source }));
      return null;
    }
    return picked.slice(prefix.length);
  }

  // Custom installer hands argv control to the card → the validator forbids running it elevated, so the
  // switch is disabled (and forced off) for `custom` (mirrors the manifest refine).
  private updateInstallRunAsAdminState(type: InstallType): void {
    const custom = type === 'custom';
    if (custom) this.installRunAsAdminSwitch.checked = false;
    setElDisabled(this.installRunAsAdminSwitch, custom);
  }

  private updateSectionVisibility(): void {
    this.execSection.hidden = this.launchMode === 'steam';
    this.installSection.hidden = this.launchMode !== 'installer';
    this.steamSection.hidden = this.launchMode !== 'steam';
    this.updateCopyToPcState();
  }

  // ── DOM builders ────────────────────────────────────────────────────────────

  private addSection(id: SectionId, children: readonly HTMLElement[]): void {
    const panel = document.createElement('section');
    panel.className = 'form-section';
    panel.append(...children);
    this.sectionPanels.set(id, panel);
    this.deps.root.append(panel);
  }

  private group(children: readonly HTMLElement[]): HTMLElement {
    const group = document.createElement('div');
    group.className = 'field-group';
    group.append(...children);
    return group;
  }

  // A labelled control. `errorKey` (when set) registers the inline error slot and the field container so a
  // corrupt note can be shown.
  private field(labelKey: MessageKey, errorKey: FieldKey | null, control: HTMLElement): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    wrapper.append(this.fieldLabel(labelKey), control);
    if (errorKey !== null) {
      wrapper.append(this.errorSlot(errorKey));
      this.registerContainer(errorKey, wrapper);
    }
    return wrapper;
  }

  // A switch field laid out like the Settings window: the label sits to the LEFT of the switch, via
  // fluent-field (label-position="after" + slotted switch/label). An error slot sits below.
  private switchField(labelKey: MessageKey, errorKey: FieldKey, control: CheckedEl): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const field = document.createElement('fluent-field');
    field.setAttribute('label-position', 'after');
    const id = `sw-${errorKey.replace(/\W/g, '-')}`;
    control.setAttribute('slot', 'input');
    control.id = id;
    const label = document.createElement('label');
    label.setAttribute('slot', 'label');
    label.setAttribute('for', id);
    this.labelRefs.push({ el: label, key: labelKey });
    field.append(control, label);
    wrapper.append(field, this.errorSlot(errorKey));
    this.registerContainer(errorKey, wrapper);
    return wrapper;
  }

  // A labelled control with a trailing Browse… button that fills it from a picked path.
  // `transform` post-processes the picked path before it lands in the control; returning null rejects the
  // pick (the transform having reported why) and leaves the current value alone.
  private fieldWithBrowse(
    labelKey: MessageKey,
    errorKey: FieldKey,
    control: ValueEl,
    kind: ConfigPickKind,
    transform?: (picked: string) => string | null,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const row = document.createElement('div');
    row.className = 'field-row';
    const browse = this.textButton('configure.browse', async () => {
      // pc-save points OUTSIDE the card, at a location that on Linux lives inside this game's Wine prefix —
      // so hand main the id being edited and it can open the dialog right there instead of at some default
      // the user then has to walk out of. Other kinds pick from the card and don't need it.
      const gameId = kind === 'pc-save' ? getValue(this.idInput) : undefined;
      const result = await this.deps.pickPath(kind, gameId);
      if (result.ok) {
        const picked = result.paths[0] ?? getValue(control);
        const next = transform === undefined ? picked : transform(picked);
        if (next === null) return;
        control.value = next;
        this.clearCorrupt(topLevelOf(errorKey));
        this.deps.onChange();
      } else if (!('cancelled' in result)) {
        this.deps.onPickError(result.message);
      }
    });
    row.append(control, browse);
    wrapper.append(this.fieldLabel(labelKey), row, this.errorSlot(errorKey));
    this.registerContainer(errorKey, wrapper);
    return wrapper;
  }

  // An audio field: a Default/Custom selector plus (in Custom) a text-input + Browse + clear. Default and
  // Custom-empty both leave the value empty → the field is omitted from game.json (built-in sound / no
  // music), and a hint says so. Value state IS the model (empty = default); the toggle is pure UI.
  private audioField(
    labelKey: MessageKey,
    errorKey: FieldKey,
    corruptKey: string,
    hintKey: MessageKey,
  ): AudioField {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';

    // Default → the field is omitted from game.json (built-in sound / no music); Custom → a path field.
    const modeSelect = this.dropdown([
      ['default', 'configure.audioDefault'],
      ['custom', 'configure.audioCustom'],
    ]);
    modeSelect.classList.add('audio-mode');

    const row = document.createElement('div');
    row.className = 'field-row';
    const input = document.createElement('fluent-text-input') as ValueEl;
    input.setAttribute('type', 'text');
    const browse = this.textButton('configure.browse', async () => {
      const result = await this.deps.pickPath('audio');
      if (result.ok) {
        input.value = result.paths[0] ?? getValue(input);
        setMode('custom');
        this.clearCorrupt(corruptKey);
        this.deps.onChange();
      } else if (!('cancelled' in result)) {
        this.deps.onPickError(result.message);
      }
    });
    // No separate clear button: selecting "Default" in the dropdown clears the field and omits it.
    row.append(input, browse);

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    this.labelRefs.push({ el: hint, key: hintKey });

    wrapper.append(this.fieldLabel(labelKey), modeSelect, row, hint, this.errorSlot(errorKey));
    this.registerContainer(errorKey, wrapper);

    let mode: 'default' | 'custom' = 'default';
    const refresh = (): void => {
      const empty = getValue(input) === '';
      row.hidden = mode === 'default';
      hint.hidden = !(mode === 'default' || empty);
      modeSelect.value = mode;
    };
    const setMode = (next: 'default' | 'custom'): void => {
      mode = next;
      if (next === 'default') input.value = '';
      refresh();
    };
    modeSelect.addEventListener('change', () => {
      const next = getValue(modeSelect) === 'custom' ? 'custom' : 'default';
      const clearedValue = next === 'default' && getValue(input) !== '';
      setMode(next);
      // Only a real content change (clearing a set path) marks dirty/re-validates; merely revealing the
      // empty Custom input does not.
      if (clearedValue) {
        this.clearCorrupt(corruptKey);
        this.deps.onChange();
      }
    });
    input.addEventListener('input', () => {
      this.clearCorrupt(corruptKey);
      refresh();
      this.deps.onChange();
    });

    return {
      wrapper,
      input,
      setValue: (value) => {
        mode = value === '' ? 'default' : 'custom';
        input.value = value;
        refresh();
      },
      setDisabled: (disabled) => {
        for (const el of [input, browse, modeSelect]) setElDisabled(el, disabled);
      },
    };
  }

  private dynamicList(
    corruptKey: string,
    labelKey: MessageKey,
    opts: {
      readonly browseKind?: ConfigPickKind;
      readonly browseLabelKey?: MessageKey;
      readonly replaceKind?: ConfigPickKind;
      readonly preview?: boolean;
      readonly reorder?: boolean;
      readonly noAdd?: boolean;
      /** Error slot / container key, when it must differ from `corruptKey` (e.g. a second list sharing the
       * `install` block's corrupt-clear but needing its own error slot). Defaults to the corruptKey rule. */
      readonly errorKey?: FieldKey;
    } = {},
  ): DynamicList {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const rows = document.createElement('div');
    rows.className = 'list-rows';
    const buttonRow = document.createElement('div');
    buttonRow.className = 'button-row';

    // Drag-and-drop reordering (native HTML5 DnD, no dependency): a grip handle per row starts the drag,
    // and dragover on the container live-repositions the dragged row. The handle is hidden with a single
    // row (nothing to reorder). onChange fires once on dragend.
    let draggingRow: HTMLElement | null = null;
    const refreshHandles = (): void => {
      if (opts.reorder !== true) return;
      const many = rows.children.length > 1;
      for (const handle of rows.querySelectorAll<HTMLElement>('.drag-handle')) handle.hidden = !many;
    };
    if (opts.reorder === true) {
      rows.addEventListener('dragover', (event) => {
        if (draggingRow === null) return;
        event.preventDefault();
        const after = dragAfterElement(rows, event.clientY, draggingRow);
        if (after === null) rows.append(draggingRow);
        else if (after !== draggingRow) rows.insertBefore(draggingRow, after);
      });
      rows.addEventListener('drop', (event) => event.preventDefault());
    }

    const addRow = (value: string): void => {
      const row = document.createElement('div');
      row.className = 'list-row';
      // Drag handle (grip) — the row is reordered by dragging this, not the whole row (so the text field
      // stays selectable). Hidden when there's a single row (see refreshHandles).
      if (opts.reorder === true) {
        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.textContent = '⠿';
        handle.setAttribute('draggable', 'true');
        handle.setAttribute('role', 'button');
        handle.setAttribute('data-i18n-aria-label-key', 'configure.dragReorder');
        handle.addEventListener('dragstart', (event) => {
          draggingRow = row;
          row.classList.add('dragging');
          event.dataTransfer?.setData('text/plain', ''); // some browsers need data to start a drag
          if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
        });
        handle.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          draggingRow = null;
          refreshHandles();
          this.deps.onChange();
        });
        row.append(handle);
      }
      const input = document.createElement('fluent-text-input') as ValueEl;
      input.setAttribute('type', 'text');
      input.value = value;

      let thumb: HTMLImageElement | null = null;
      const refreshThumb = (): void => {
        const el = thumb;
        if (el === null) return;
        const current = getValue(input);
        if (current === '') {
          el.hidden = true;
          el.removeAttribute('src');
          return;
        }
        void this.deps.imagePreview(current).then((url) => {
          if (url !== null) {
            el.src = url;
            el.hidden = false;
          } else {
            el.hidden = true;
            el.removeAttribute('src');
          }
        });
      };
      if (opts.preview === true) {
        thumb = document.createElement('img');
        thumb.className = 'hero-thumb';
        thumb.alt = '';
        thumb.hidden = true;
        // Click the thumbnail → open a full-size lightbox of the same (already-loaded) data URL.
        thumb.addEventListener('click', () => {
          const src = thumb?.getAttribute('src');
          if (src !== null && src !== undefined && src !== '') this.openImagePreview(src);
        });
        row.append(thumb);
      }

      input.addEventListener('input', () => {
        this.clearCorrupt(corruptKey);
        this.deps.onChange();
      });
      if (opts.preview === true) input.addEventListener('change', () => refreshThumb());
      row.append(input);
      // Per-row "Replace…" — pick a file and swap THIS row's value (hero images).
      if (opts.replaceKind !== undefined) {
        const kind = opts.replaceKind;
        const replace = this.textButton('configure.replace', async () => {
          const result = await this.deps.pickPath(kind);
          if (result.ok) {
            const picked = result.paths[0];
            if (picked !== undefined) {
              input.value = picked;
              this.clearCorrupt(corruptKey);
              refreshThumb();
              this.deps.onChange();
            }
          } else if (!('cancelled' in result)) {
            this.deps.onPickError(result.message);
          }
        });
        row.append(replace);
      }
      const remove = this.iconButton('configure.remove', trashIcon(), () => {
        row.remove();
        refreshHandles();
        this.clearCorrupt(corruptKey);
        this.deps.onChange();
      });
      remove.classList.add('icon-danger');
      row.append(remove);
      rows.append(row);
      refreshHandles();
      refreshThumb();
      // Rows are built AFTER the constructor's applyLabels(), so label their fresh elements (the Replace…
      // text, drag-handle/remove aria) now — otherwise they stay blank until the next language change.
      this.applyLabels();
    };

    // Hero images are added via Browse… (multi-select) — no manual "Add" row there (opts.noAdd).
    if (opts.noAdd !== true) {
      const addBtn = this.textButton('configure.add', () => {
        addRow('');
        this.deps.onChange();
      });
      buttonRow.append(addBtn);
    }
    if (opts.browseKind !== undefined) {
      const kind = opts.browseKind;
      const browse = this.textButton(opts.browseLabelKey ?? 'configure.browse', async () => {
        const result = await this.deps.pickPath(kind);
        if (result.ok) {
          for (const p of result.paths) addRow(p);
          this.clearCorrupt(corruptKey);
          this.deps.onChange();
        } else if (!('cancelled' in result)) {
          this.deps.onPickError(result.message);
        }
      });
      buttonRow.append(browse);
    }

    const errorKey: FieldKey =
      opts.errorKey ?? (corruptKey === 'install' ? 'install.args' : (corruptKey as FieldKey));
    wrapper.append(this.fieldLabel(labelKey), rows, buttonRow, this.errorSlot(errorKey));
    this.registerContainer(errorKey, wrapper);

    return {
      wrapper,
      values: () => [...rows.querySelectorAll('fluent-text-input')].map((el) => getValue(el as ValueEl)),
      setValues: (values) => {
        rows.replaceChildren();
        for (const value of values) addRow(value);
      },
      setDisabled: (disabled) => {
        for (const el of buttonRow.querySelectorAll('fluent-button')) setElDisabled(el as HTMLElement, disabled);
        for (const el of rows.querySelectorAll('fluent-text-input, fluent-button')) {
          setElDisabled(el as HTMLElement, disabled);
        }
        // Disable dragging while blocked; re-assert single-row handle visibility when re-enabling.
        for (const handle of rows.querySelectorAll<HTMLElement>('.drag-handle')) {
          handle.setAttribute('draggable', disabled ? 'false' : 'true');
        }
        if (!disabled) refreshHandles();
      },
    };
  }

  private textInput(corruptKey: string): ValueEl {
    const input = document.createElement('fluent-text-input') as ValueEl;
    input.setAttribute('type', 'text');
    input.addEventListener('input', () => {
      this.clearCorrupt(corruptKey);
      this.deps.onChange();
    });
    return input;
  }

  private numberInput(corruptKey: string): ValueEl {
    const input = this.textInput(corruptKey);
    // `type="number"` is not part of Fluent v3's TextInputType — use text + numeric inputmode (plan R7).
    input.setAttribute('inputmode', 'numeric');
    return input;
  }

  private switchControl(corruptKey: string): CheckedEl {
    const control = document.createElement('fluent-switch') as CheckedEl;
    control.addEventListener('change', () => {
      this.clearCorrupt(corruptKey);
      this.deps.onChange();
    });
    return control;
  }

  private dropdown(options: ReadonlyArray<readonly [string, string]>): ValueEl {
    const dropdown = document.createElement('fluent-dropdown') as ValueEl;
    const listbox = document.createElement('fluent-listbox');
    for (const [value, label] of options) {
      const option = document.createElement('fluent-option');
      (option as ValueEl).value = value;
      if (isMessageKey(label)) this.optionRefs.push({ el: option, key: label });
      else option.textContent = label; // literal (brand) label
      listbox.append(option);
    }
    dropdown.append(listbox);
    return dropdown;
  }

  private fieldLabel(labelKey: MessageKey): HTMLElement {
    const label = document.createElement('span');
    label.className = 'field-label';
    this.labelRefs.push({ el: label, key: labelKey });
    return label;
  }

  private errorSlot(errorKey: FieldKey): HTMLElement {
    const error = document.createElement('div');
    error.className = 'field-error';
    this.errorEls.set(errorKey, error);
    return error;
  }

  private textButton(labelKey: MessageKey, onClick: () => void | Promise<void>): HTMLElement {
    const button = document.createElement('fluent-button');
    this.labelRefs.push({ el: button, key: labelKey });
    button.addEventListener('click', () => void onClick());
    return button;
  }

  // Opens a full-size lightbox of a hero image (the data URL already loaded in the thumbnail). Click
  // anywhere (or Escape) closes it. Self-contained — CSP allows img-src data:.
  private openImagePreview(url: string): void {
    const veil = document.createElement('div');
    veil.className = 'image-preview-veil';
    const image = document.createElement('img');
    image.className = 'image-preview-img';
    image.alt = '';
    image.src = url;
    veil.append(image);
    const close = (): void => {
      veil.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    veil.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(veil);
  }

  private iconButton(labelKey: MessageKey, content: string | Node, onClick: () => void): HTMLElement {
    const button = document.createElement('fluent-button');
    button.className = 'icon-button';
    button.setAttribute('appearance', 'transparent'); // chrome-less: just the icon
    if (typeof content === 'string') button.textContent = content;
    else button.append(content);
    button.setAttribute('data-i18n-aria-label-key', labelKey); // aria label re-applied in applyLabels
    button.addEventListener('click', onClick);
    return button;
  }

  private registerContainer(errorKey: FieldKey, wrapper: HTMLElement): void {
    const top = topLevelOf(errorKey);
    if (!this.containers.has(top)) this.containers.set(top, wrapper);
  }

  private applyLabels(): void {
    const t = this.deps.translator();
    for (const { el, key } of this.labelRefs) el.textContent = t(key);
    for (const { el, key } of this.optionRefs) el.textContent = t(key);
    for (const { el, key } of this.placeholderRefs) el.setAttribute('placeholder', t(key));
    for (const button of this.deps.root.querySelectorAll('[data-i18n-aria-label-key]')) {
      const key = button.getAttribute('data-i18n-aria-label-key');
      if (key !== null) button.setAttribute('aria-label', t(key as MessageKey));
    }
  }
}

// ── Free helpers ──────────────────────────────────────────────────────────────

function setElDisabled(el: HTMLElement, disabled: boolean): void {
  if (disabled) el.setAttribute('disabled', '');
  else el.removeAttribute('disabled');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Trash/bin icon (from the supplied SVG) for the remove-row button. Built via DOM (no innerHTML); the
// stroke colour is set in CSS (.trash-icon path → #A80000).
const TRASH_PATHS = [
  'M3 6H21M5 6V20C5 21.1046 5.89543 22 7 22H17C18.1046 22 19 21.1046 19 20V6M8 6V4C8 2.89543 8.89543 2 10 2H14C15.1046 2 16 2.89543 16 4V6',
  'M14 11V17',
  'M10 11V17',
];
function trashIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'trash-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of TRASH_PATHS) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

/** During a drag, finds the row the dragged one should be inserted BEFORE for a given pointer Y (the first
 * row whose vertical midpoint is below the cursor), or null to append at the end. Skips the dragged row. */
function dragAfterElement(container: HTMLElement, y: number, dragging: HTMLElement): HTMLElement | null {
  const rows = [...container.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== dragging);
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (y < box.top + box.height / 2) return row;
  }
  return null;
}

/** Narrows the install-type dropdown value to the enum (defaults to nsis for any unexpected value). */
// The dropdown only ever offers the three installer families — `copy` is driven by its own checkbox and
// must never surface here, hence the narrowed return type (an unknown value falls back to nsis, as before).
function toInstallType(value: string): InstallerFamily {
  return value === 'inno' || value === 'custom' ? value : 'nsis';
}

/** The top-level manifest key a field error belongs to (for corrupt-note grouping). */
function topLevelOf(key: FieldKey): string {
  // The copy fields live in the `install` block too — editing them must clear ITS corrupt state.
  if (key === 'copySource' || key === 'copyToPc') return 'install';
  if (key.startsWith('install.')) return 'install';
  if (key.startsWith('sounds.')) return 'sounds';
  if (key === 'steam.appid') return 'steam';
  return key;
}

/**
 * Maps a validation issue path onto a form field error slot (prefix match), or null when unmapped.
 *
 * `copyToPc` is needed because the SAME manifest path means different things per mode: with the checkbox
 * on, `install.installer` is the copy-source field in the Executable section, and its errors (an empty
 * source, a path escaping the card root) must appear there — the Installer section is hidden, so an
 * error routed to it would block Save with no visible cause.
 */
function fieldKeyForPath(path: string, copyToPc: boolean): FieldKey | null {
  switch (path) {
    case 'id':
    case 'title':
    case 'executable':
    case 'args':
    case 'runAsAdmin':
    case 'watchProcesses':
    case 'saveOnCard':
    case 'pcSavePath':
    case 'backgroundMusic':
    case 'umuGameId':
    case 'launchTimeoutSec':
    case 'killTimeoutSec':
      return path;
    default:
      break;
  }
  if (path === 'heroImage' || path.startsWith('heroImage.')) return 'heroImage';
  if (path === 'winetricks' || path.startsWith('winetricks.')) return 'winetricks';
  if (path === 'steam' || path.startsWith('steam.')) return 'steam.appid';
  if (path === 'install' || path === 'install.installer') {
    return copyToPc ? 'copySource' : 'install.installer';
  }
  // In copy mode the remaining install.* fields have no control of their own (the type is implicit, and
  // args/runAsAdmin are rejected by the schema) — leave them unmapped so they surface in the #issues
  // panel rather than in a slot the user cannot see.
  if (path.startsWith('install.')) {
    if (copyToPc) return null;
    if (path === 'install.type') return 'install.type';
    if (path === 'install.runAsAdmin') return 'install.runAsAdmin';
    if (path.startsWith('install.winetricks')) return 'install.winetricks';
    if (path.startsWith('install.args')) return 'install.args';
  }
  if (path === 'sounds' || path === 'sounds.play') return 'sounds.play';
  if (path === 'sounds.navigate') return 'sounds.navigate';
  if (path === 'sounds.button') return 'sounds.button';
  if (path === 'sounds.back') return 'sounds.back';
  return null;
}

const MESSAGE_KEY_PREFIXES = ['configure.', 'common.', 'window.'];
function isMessageKey(label: string): label is MessageKey {
  return MESSAGE_KEY_PREFIXES.some((p) => label.startsWith(p));
}

/** Re-exported so configure.ts parses text without importing the model module twice. */
export { textToFormModel, type ParseFormResult };
