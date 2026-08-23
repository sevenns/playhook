import { describe, expect, it } from 'vitest';
import {
  bundleExecutablePath,
  infoPlistPath,
  isAppBundlePath,
  parseCFBundleExecutable,
} from '../src/main/platform/app-bundle.darwin';

const XML_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Valheim</string>
	<key>CFBundleExecutable</key>
	<string>valheim.x86_64</string>
	<key>CFBundleIdentifier</key>
	<string>com.irongate.valheim</string>
</dict>
</plist>
`;

describe('darwin app bundle — path helpers', () => {
  it('recognizes a .app bundle path, case-insensitively and with a trailing slash', () => {
    expect(isAppBundlePath('/Applications/Valheim.app')).toBe(true);
    expect(isAppBundlePath('/Applications/Valheim.APP/')).toBe(true);
    expect(isAppBundlePath('/Applications/valheim')).toBe(false);
    expect(isAppBundlePath('/Games/valheim.exe')).toBe(false);
  });

  it('builds the Info.plist and Contents/MacOS paths with posix separators', () => {
    expect(infoPlistPath('/Applications/Valheim.app')).toBe(
      '/Applications/Valheim.app/Contents/Info.plist',
    );
    expect(bundleExecutablePath('/Applications/Valheim.app', 'valheim.x86_64')).toBe(
      '/Applications/Valheim.app/Contents/MacOS/valheim.x86_64',
    );
  });
});

describe('darwin app bundle — Info.plist parsing', () => {
  it('reads CFBundleExecutable out of an XML plist', () => {
    expect(parseCFBundleExecutable(XML_PLIST)).toBe('valheim.x86_64');
  });

  it('returns null when the key is absent', () => {
    expect(parseCFBundleExecutable('<plist><dict><key>CFBundleName</key><string>X</string></dict></plist>')).toBeNull();
  });

  it('returns null for an empty or whitespace-only value', () => {
    expect(
      parseCFBundleExecutable('<key>CFBundleExecutable</key>\n<string>   </string>'),
    ).toBeNull();
  });

  it('decodes XML entities in the executable name', () => {
    expect(
      parseCFBundleExecutable('<key>CFBundleExecutable</key><string>Rock &amp; Roll</string>'),
    ).toBe('Rock & Roll');
  });
});
