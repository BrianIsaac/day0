import { describe, expect, it } from 'vitest';
import {
  feishuLocator,
  feishuReaderSecret,
  parseFeishuLocator,
  parseFeishuSecret,
} from '../../../src/docs/feishu-source';

describe('the Feishu locator and reader secret', (): void => {
  it('names the region by its host and the space or folder by its path', (): void => {
    expect(parseFeishuLocator('https://open.feishu.cn/wiki/spaces/7300000000000000001')).toEqual({
      region: 'feishu',
      host: 'open.feishu.cn',
      scope: { kind: 'wiki', spaceId: '7300000000000000001' },
    });
    expect(
      parseFeishuLocator('https://open.larksuite.com/drive/folders/fldcnArchive000000000000000'),
    ).toEqual({
      region: 'lark',
      host: 'open.larksuite.com',
      scope: { kind: 'folder', folderToken: 'fldcnArchive000000000000000' },
    });
  });

  it('refuses any other host, scheme or path, and never repeats the locator', (): void => {
    for (const locator of [
      'http://open.feishu.cn/wiki/spaces/7300000000000000001',
      'https://open.feishu.cn.example.com/wiki/spaces/7300000000000000001',
      'https://acme.feishu.cn/wiki/spaces/7300000000000000001',
      'https://open.feishu.cn/wiki/spaces/',
      'https://open.feishu.cn/wiki/spaces/73000/extra',
      'https://open.feishu.cn/docx/doxcnRevOpsHandbook00000000',
      'https://user:pass@open.feishu.cn/wiki/spaces/7300000000000000001',
      'not a url',
    ]) {
      let message = '';
      try {
        parseFeishuLocator(locator);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain('A Feishu location is');
      expect(message).not.toContain('user:pass');
    }
  });

  it('builds the locator from what the link form was given', (): void => {
    const space = 'https://open.feishu.cn/wiki/spaces/7300000000000000001';
    expect(feishuLocator('feishu', '7300000000000000001')).toBe(space);
    expect(feishuLocator('feishu', ' https://acme.feishu.cn/wiki/space/7300000000000000001 ')).toBe(
      space,
    );
    expect(
      feishuLocator('feishu', 'https://acme.feishu.cn/wiki/settings/7300000000000000001'),
    ).toBe(space);
    expect(
      feishuLocator('lark', 'https://acme.larksuite.com/drive/folder/fldcnArchive000000000000000'),
    ).toBe('https://open.larksuite.com/drive/folders/fldcnArchive000000000000000');
    expect(feishuLocator('lark', 'fldcnArchive000000000000000')).toBe(
      'https://open.larksuite.com/drive/folders/fldcnArchive000000000000000',
    );
    // What it cannot read as a space or a folder is kept as typed, for the link to refuse.
    expect(feishuLocator('feishu', 'https://acme.feishu.cn/docx/doxcnRevOpsHandbook00000000')).toBe(
      'https://acme.feishu.cn/docx/doxcnRevOpsHandbook00000000',
    );
  });

  it('joins and splits the app ID and secret', (): void => {
    expect(feishuReaderSecret(' cli_fixture_app ', ' fixture-app-secret ')).toBe(
      'cli_fixture_app:fixture-app-secret',
    );
    expect(parseFeishuSecret('cli_fixture_app:fixture-app-secret')).toEqual({
      appId: 'cli_fixture_app',
      appSecret: 'fixture-app-secret',
    });
    for (const secret of [
      '',
      'cli_fixture_app',
      ':fixture-app-secret',
      'cli_fixture_app:',
      'a b:c',
    ]) {
      expect(() => parseFeishuSecret(secret), secret).toThrow(
        "A Feishu reader secret is the app's ID and its secret",
      );
    }
  });
});
