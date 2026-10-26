import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { solutionFolder } from '../../src/core/derive/artifacts.ts';

/** M4.3: the agent card's path line, the workspace-relative folder of the solution a written file belongs to. */
describe('solutionFolder', () => {
  const root = path.resolve('/ws/work space');
  const at = (...parts: string[]) => path.join(root, ...parts);

  it('grouping folders → <group>/<repo>; a worktree sibling maps to its repo', () => {
    expect(solutionFolder(root, at('microfrontends', 'acme-web-front', 'Pages', 'X.razor'))).toBe('microfrontends/acme-web-front');
    expect(solutionFolder(root, at('functions', 'invoice-func', 'a.cs'))).toBe('functions/invoice-func');
    expect(solutionFolder(root, at('nugets', 'design-kit-nuget', 'x.cs'))).toBe('nugets/design-kit-nuget');
    expect(solutionFolder(root, at('microfrontends', 'acme-web-front-wt-checkout', 'x.razor'), 'checkout')).toBe('microfrontends/acme-web-front');
    expect(solutionFolder(root, 'microservices/orders-microservice/swagger.yml')).toBe('microservices/orders-microservice');
  });

  it('repos at the root → <repo>/ (mobile/, infrastructure/, a root worktree of mobile); deprecated keeps its type folder', () => {
    expect(solutionFolder(root, at('mobile', 'Views', 'X.xaml'))).toBe('mobile/');
    expect(solutionFolder(root, at('mobile-wt-checkout', 'Views', 'X.xaml'), 'checkout')).toBe('mobile/');
    expect(solutionFolder(root, at('infrastructure', 'main.tf'))).toBe('infrastructure/');
    expect(solutionFolder(root, at('deprecated', 'microfrontends', 'old-front', 'x.razor'))).toBe('deprecated/microfrontends/old-front');
  });

  it('the workspace root itself and paths outside it → null', () => {
    expect(solutionFolder(root, at('contracts', 'checkout.md'))).toBeNull();
    expect(solutionFolder(root, at('out.txt'))).toBeNull();
    expect(solutionFolder(root, at('microfrontends', 'loose.md'))).toBeNull();
    expect(solutionFolder(root, path.resolve('/elsewhere/x.md'))).toBeNull();
  });
});
