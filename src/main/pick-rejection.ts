// Whether a path may fill a manifest field of a given kind, in words the user reads. Sits beside
// config-paths.ts (the pure type check) rather than in the picker service: GameConfigService asks the
// same question for a path that reaches it from the history editor, and the core must not import from
// the picker built on top of it.
import fs from 'node:fs/promises';
import { type ConfigPickKind } from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS } from './asset-reader';
import { acceptsExtensions, checkPickedType, type PickRejection } from './config-paths';

/** The extensions a field accepts, with the two asset lists filled in from the AssetReader. */
function extensionsFor(kind: ConfigPickKind): readonly string[] | null {
  if (kind === 'image') return IMAGE_EXTENSIONS;
  if (kind === 'audio') return AUDIO_EXTENSIONS;
  return acceptsExtensions(kind);
}

/** The localized wording of a refusal from checkPickedType. */
function rejectionMessage(rejection: PickRejection, t: Translator): string {
  switch (rejection) {
    case 'missing':
      return t('gameConfig.pickMissing');
    case 'symlink':
      return t('gameConfig.pickSymlink');
    case 'needs-folder':
      return t('gameConfig.pickNeedsFolder');
    case 'needs-file':
      return t('gameConfig.pickNeedsFile');
    case 'wrong-type':
      return t('gameConfig.pickWrongType');
  }
}

/** Whether one picked path may be used for `kind`; a localized reason when it may not, else null. */
export async function describePickRejection(
  absolute: string,
  kind: ConfigPickKind,
  t: Translator,
): Promise<string | null> {
  let stat: Parameters<typeof checkPickedType>[2] = null;
  try {
    const stats = await fs.lstat(absolute);
    stat = {
      isSymbolicLink: stats.isSymbolicLink(),
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
    };
  } catch {
    stat = null;
  }
  const rejection = checkPickedType(absolute, kind, stat, extensionsFor(kind));
  return rejection === null ? null : rejectionMessage(rejection, t);
}
