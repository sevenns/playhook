// The title cleanup the word-matching sources need. Measured against live answers for Watch_Dogs™:
// with the marks in place Wallhaven and Wallpaper Cave found nothing and Khinsider found other games.
import { describe, expect, it } from 'vitest';
import { searchableTitle } from '../src/main/metadata/search-title';
import { searchTerms } from '../src/main/metadata/wallhaven';
import { searchUrl as khinsiderSearchUrl } from '../src/main/metadata/khinsider';

describe('searchable title', () => {
  it('drops the trademark marks publishers put in a name', () => {
    expect(searchableTitle('Watch_Dogs™')).toBe('Watch Dogs');
    expect(searchableTitle('Watch_Dogs® 2')).toBe('Watch Dogs 2');
    expect(searchableTitle('PAYDAY 2©')).toBe('PAYDAY 2');
  });

  it('reads an underscore as the space it stands for', () => {
    expect(searchableTitle('Watch_Dogs')).toBe('Watch Dogs');
  });

  it('leaves a title that needs nothing exactly as it was', () => {
    expect(searchableTitle('The Witcher 3: Wild Hunt')).toBe('The Witcher 3: Wild Hunt');
    expect(searchableTitle('Ведьмак 3')).toBe('Ведьмак 3');
  });

  it('collapses what the removals leave behind', () => {
    expect(searchableTitle('Hades ™  ')).toBe('Hades');
    expect(searchableTitle('   ')).toBe('');
  });
});

describe('the sources that match on words use it', () => {
  it('wallhaven searches for the cleaned title, and trims editions from that', () => {
    expect(searchTerms('Watch_Dogs™')).toEqual(['Watch Dogs']);
    expect(searchTerms('Watch_Dogs® 2 - Gold Edition')).toEqual([
      'Watch Dogs 2 - Gold Edition',
      'Watch Dogs 2',
    ]);
  });

  it('khinsider searches for the cleaned title', () => {
    expect(khinsiderSearchUrl('Watch_Dogs™')).toContain('search=Watch%20Dogs');
  });
});
