import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { solutionFolder } from '../../src/core/derive/artifacts.ts';

/** M4.3: the agent card's path line, the workspace-relative folder of the solution a written file belongs to. */
describe('solutionFolder', () => {
  const root = path.resolve('/ws/work space');
  const at = (...parts: string[]) => path.join(root, ...parts);

  it('grouping folders → <group>/<repo>; a worktree sibling maps to its repo', () => {
    expect(solutionFolder(root, at('microfrontends', 'acme-app-front', 'Pages', 'X.razor'))).toBe('microfrontends/acme-app-front');
    expect(solutionFolder(root, at('functions', 'calendar-func', 'a.cs'))).toBe('functions/calendar-func');
    expect(solutionFolder(root, at('nugets', 'components-library-nuget', 'x.cs'))).toBe('nugets/components-library-nuget');
    expect(solutionFolder(root, at('microfrontends', 'acme-app-front-wt-free-talk', 'x.razor'), 'free-talk')).toBe('microfrontends/acme-app-front');
    expect(solutionFolder(root, 'microservices/notifications-microservice/swagger.yml')).toBe('microservices/notifications-microservice');
  });

  it('repos at the root → <repo>/ (mobile/, infrastructure/, a root worktree of mobile); deprecated keeps its type folder', () => {
    expect(solutionFolder(root, at('mobile', 'Views', 'X.xaml'))).toBe('mobile/');
    expect(solutionFolder(root, at('mobile-wt-free-talk', 'Views', 'X.xaml'), 'free-talk')).toBe('mobile/');
    expect(solutionFolder(root, at('infrastructure', 'main.tf'))).toBe('infrastructure/');
    expect(solutionFolder(root, at('deprecated', 'microfrontends', 'old-front', 'x.razor'))).toBe('deprecated/microfrontends/old-front');
  });

  it('the workspace root itself and paths outside it → null', () => {
    expect(solutionFolder(root, at('contracts', 'free-talk.md'))).toBeNull();
    expect(solutionFolder(root, at('out.txt'))).toBeNull();
    expect(solutionFolder(root, at('microfrontends', 'loose.md'))).toBeNull();
    expect(solutionFolder(root, path.resolve('/elsewhere/x.md'))).toBeNull();
  });
});
