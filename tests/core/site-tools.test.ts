import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, isSiteToolUrl } from '../../src/core/site-tools.ts';

/** D28: which tools are signed-in sites (direct frame through the helper) and which stay local (D15 proxy). */
describe('isSiteToolUrl (D28)', () => {
  it('a non-loopback https URL is a site', () => {
    expect(isSiteToolUrl('https://acme.atlassian.net/jira/software/c/projects/PROJ/boards/1')).toBe(true);
    expect(isSiteToolUrl('https://grafana.example.com:8443/d/x?orgId=1#panel')).toBe(true);
    expect(isSiteToolUrl('HTTPS://Acme.Atlassian.NET')).toBe(true);
    expect(isSiteToolUrl('https://192.168.1.20/')).toBe(true); // another machine: not loopback
    expect(isSiteToolUrl('https://site.test:4431/')).toBe(true);
  });

  it('http URLs, loopback hosts and non-URLs are local tools', () => {
    for (const url of [
      'http://localhost:13000',
      'http://acme.atlassian.net/',
      'https://localhost:3000/',
      'https://app.localhost/',
      'https://127.0.0.1:8443/',
      'https://127.3.2.1/',
      'https://0.0.0.0/',
      'https://[::1]:8443/',
      'https://[::ffff:127.0.0.1]/',
      'https://localhost./',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(isSiteToolUrl(url), String(url)).toBe(false);
    }
  });
});

describe('isLoopbackHostname (D28)', () => {
  it('names this machine', () => {
    for (const host of ['localhost', 'LOCALHOST', 'a.b.localhost', '127.0.0.1', '127.255.255.254', '0.0.0.0', '[::1]', '[::ffff:7f00:1]', 'localhost.']) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it('anything else is not loopback', () => {
    for (const host of ['example.com', 'localhost.example.com', 'mylocalhost', '128.0.0.1', '10.0.0.1', '[::2]', '[::ffff:a00:1]', '']) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});
