import { describe, expect, it } from 'vitest';
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
});
