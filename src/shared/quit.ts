import type { Translator } from './i18n/index';

/** A managed way out of the launcher: quitting it, or shutting the PC down or rebooting it. */
export type QuitAction = 'quit' | 'shutdown' | 'reboot';

/** The launcher window's answer to main's quit question: shown (or queued), or closed without a Yes. */
export type QuitConfirmReply = 'shown' | 'dismissed';

/** The question asked before `action` while `jobs` installs / uninstalls are running; 0 asks the plain one. */
export function quitQuestion(t: Translator, action: QuitAction, jobs: number): string {
  if (jobs > 0) {
    if (action === 'shutdown') return t.tp('launcher.confirm.shutdownWithJobs', jobs);
    if (action === 'reboot') return t.tp('launcher.confirm.rebootWithJobs', jobs);
    return t.tp('launcher.confirm.quitWithJobs', jobs);
  }
  if (action === 'shutdown') return t('launcher.confirm.shutdown');
  if (action === 'reboot') return t('launcher.confirm.reboot');
  return t('launcher.confirm.quit');
}
