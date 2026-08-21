import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captionPathFromManifest, resolveMediaRequest } from '@main/media-protocol';

const rootsToRemove: string[] = [];

afterEach(() => {
  for (const root of rootsToRemove.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-protocol-'));
  rootsToRemove.push(root);
  const projects = join(root, 'projects');
  const media = join(root, 'media');
  const output = join(root, 'output');
  mkdirSync(projects, { recursive: true });
  mkdirSync(media, { recursive: true });
  mkdirSync(output, { recursive: true });
  const render = join(output, 'final.mp4');
  const caption = join(projects, 'final.vtt');
  const manifest = join(projects, 'manifest.json');
  writeFileSync(render, 'video');
  writeFileSync(caption, 'WEBVTT\n');
  writeFileSync(manifest, JSON.stringify({ captions: { vttPath: caption } }));
  return {
    root,
    roots: { mediaLibraryFolder: media, projectFolder: projects, outputFolder: output },
    render,
    caption,
    manifest
  };
}

describe('videofactory media protocol resolution', () => {
  it('serves only managed, existing artifacts and manifest-backed captions', () => {
    const value = fixture();
    const lookups = {
      render: (id: string) => id === 'render-1' ? value.render : null,
      proxy: () => null,
      thumbnail: () => null,
      captionManifest: (id: string) => id === 'render-1' ? value.manifest : null
    };
    expect(resolveMediaRequest('videofactory://render/render-1', value.roots, lookups)).toEqual({
      status: 200, kind: 'file', path: value.render
    });
    expect(resolveMediaRequest('videofactory://caption/render-1', value.roots, lookups)).toEqual({
      status: 200, kind: 'caption', path: value.caption
    });
    expect(captionPathFromManifest(value.manifest, value.roots.projectFolder)).toBe(value.caption);
  });

  it('fails closed for traversal, malformed encoding, query smuggling, and unknown types', () => {
    const value = fixture();
    const lookups = { render: () => value.render, proxy: () => value.render, thumbnail: () => value.render, captionManifest: () => value.manifest };
    expect(resolveMediaRequest('videofactory://render/..%2Fsecret', value.roots, lookups).status).toBe(400);
    expect(resolveMediaRequest('videofactory://render/%E0%A4%A', value.roots, lookups).status).toBe(400);
    expect(resolveMediaRequest('videofactory://render/render-1?path=outside', value.roots, lookups).status).toBe(400);
    expect(resolveMediaRequest('videofactory://unknown/render-1', value.roots, lookups).status).toBe(404);
  });

  it('rejects captions missing from the manifest or escaping the project root', () => {
    const value = fixture();
    const outside = join(value.root, 'outside.vtt');
    writeFileSync(outside, 'WEBVTT\n');
    writeFileSync(value.manifest, JSON.stringify({ captions: { vttPath: outside } }));
    expect(captionPathFromManifest(value.manifest, value.roots.projectFolder)).toBeNull();
    writeFileSync(value.manifest, JSON.stringify({ captions: {} }));
    expect(captionPathFromManifest(value.manifest, value.roots.projectFolder)).toBeNull();
    writeFileSync(value.manifest, '{bad json');
    expect(captionPathFromManifest(value.manifest, value.roots.projectFolder)).toBeNull();
  });
});
