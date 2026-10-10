import { describe, expect, it } from 'vitest';
import { ConfluenceCloudReader } from '../../../../src/docs/readers/confluence-v2';
import { FeishuReader } from '../../../../src/docs/readers/feishu';
import { FolderReader } from '../../../../src/docs/readers/folder';
import { GitReader } from '../../../../src/docs/readers/git';
import { McpReader } from '../../../../src/docs/readers/mcp';
import { readerFor } from '../../../../src/docs/readers';
import { UrlsReader } from '../../../../src/docs/readers/urls';

describe('documentation reader registry', (): void => {
  it('resolves every non-credential reader', (): void => {
    expect(readerFor('folder')).toBeInstanceOf(FolderReader);
    expect(readerFor('git')).toBeInstanceOf(GitReader);
    expect(readerFor('urls')).toBeInstanceOf(UrlsReader);
  });

  it('resolves the credential-bound MCP reader', (): void => {
    expect(readerFor('mcp')).toBeInstanceOf(McpReader);
  });

  it('resolves the Feishu reader, which reads as its app', (): void => {
    expect(readerFor('feishu')).toBeInstanceOf(FeishuReader);
  });

  it('resolves the Confluence Cloud reader, which reads as a service account (15-X)', (): void => {
    expect(readerFor('confluence-v2')).toBeInstanceOf(ConfluenceCloudReader);
  });

  it('names each kind whose reader has not landed as not read yet, rather than reading it as another', (): void => {
    expect(() => readerFor('sharepoint')).toThrow('Day0 does not read SharePoint sources yet.');
    expect(() => readerFor('confluence-dc')).toThrow(
      'Day0 does not read Confluence Data Center sources yet.',
    );
    expect(() => readerFor('yuque')).toThrow('Day0 does not read Yuque sources yet.');
    expect(() => readerFor('drive')).toThrow('Day0 does not read Google Drive sources yet.');
  });
});
