import { describe, expect, it } from 'vitest';
import { ConfluenceDataCenterReader } from '../../../../src/docs/readers/confluence-dc';
import { ConfluenceCloudReader } from '../../../../src/docs/readers/confluence-v2';
import { FeishuReader } from '../../../../src/docs/readers/feishu';
import { FolderReader } from '../../../../src/docs/readers/folder';
import { GitReader } from '../../../../src/docs/readers/git';
import { McpReader } from '../../../../src/docs/readers/mcp';
import { SharePointReader } from '../../../../src/docs/readers/sharepoint';
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

  it('resolves the Confluence Data Center reader, which reads with a personal access token (15-X)', (): void => {
    expect(readerFor('confluence-dc')).toBeInstanceOf(ConfluenceDataCenterReader);
  });

  it('resolves the SharePoint reader, which reads as an app registration (15-X)', (): void => {
    expect(readerFor('sharepoint')).toBeInstanceOf(SharePointReader);
  });

  it('names each kind whose reader has not landed as not read yet, rather than reading it as another', (): void => {
    expect(() => readerFor('yuque')).toThrow('Day0 does not read Yuque sources yet.');
    expect(() => readerFor('drive')).toThrow('Day0 does not read Google Drive sources yet.');
  });
});
