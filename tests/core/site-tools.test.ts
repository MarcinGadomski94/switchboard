import { describe, expect, it } from 'vitest';
import { MAX_FRAME_HELPER_HOSTS, frameHelperHosts, isFrameHelperHost, isLoopbackHostname, isSiteToolUrl, siteToolHostname } from '../../src/core/site-tools.ts';

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

describe('frameHelperHosts (D28 ruling: the hosts the page gives the frame helper)', () => {
  it("lists the page's own host first, then each saved site tool's host once, and nothing for local tools", () => {
    expect(
      frameHelperHosts(
        [
          'http://localhost:13000',
          'https://acme.atlassian.net/jira/software/c/projects/PROJ/boards/1',
          null,
          'https://grafana.example.com:8443/d/x',
          'https://Acme.Atlassian.net/wiki',
          'https://127.0.0.1:8443/',
          'not a url',
        ],
        '127.0.0.1',
      ),
    ).toEqual(['127.0.0.1', 'acme.atlassian.net', 'grafana.example.com']);
    expect(frameHelperHosts([], 'LOCALHOST')).toEqual(['localhost']);
  });

  it('leaves out hosts the helper would refuse and stops at 50', () => {
    expect(frameHelperHosts(['https://[2001:db8::1]/', 'https://jira.example.com./', 'https://site.test/'], '127.0.0.1')).toEqual(['127.0.0.1', 'site.test']);
    expect(frameHelperHosts(['https://site.test/'], '[::1]')).toEqual(['site.test']);
    const many = Array.from({ length: 60 }, (_, i) => `https://h${i}.example.com/`);
    const hosts = frameHelperHosts(many, '127.0.0.1');
    expect(hosts).toHaveLength(MAX_FRAME_HELPER_HOSTS);
    expect(hosts.slice(0, 2)).toEqual(['127.0.0.1', 'h0.example.com']);
    expect(hosts.at(-1)).toBe('h48.example.com');
  });
});

describe('isFrameHelperHost / siteToolHostname (D28 ruling)', () => {
  it('plain lower-case host names of two or more labels, IPv4 and localhost', () => {
    for (const host of ['localhost', '127.0.0.1', 'site.test', 'acme.atlassian.net', 'xn--bcher-kva.example', `${'a'.repeat(63)}.com`]) {
      expect(isFrameHelperHost(host), host).toBe(true);
    }
    for (const host of ['', 'net', 'LOCALHOST', 'Site.test', '*.atlassian.net', 'site.test:443', 'site.test/', '[::1]', 'site.test.', '.site.test', 'a..b', `${'a'.repeat(64)}.com`, `${'a.'.repeat(126)}bc`]) {
      expect(isFrameHelperHost(host), host).toBe(false);
    }
  });

  it("a site tool's hostname (lower case, no port); null for anything else", () => {
    expect(siteToolHostname('https://Acme.atlassian.net:8443/jira')).toBe('acme.atlassian.net');
    expect(siteToolHostname('http://acme.atlassian.net/')).toBeNull();
    expect(siteToolHostname('https://localhost:3000/')).toBeNull();
    expect(siteToolHostname(null)).toBeNull();
    expect(siteToolHostname('nope')).toBeNull();
  });
});
