import type { FolderSwitch } from './useFolders.ts';
import './folders.css';

/**
 * The folder switcher (D14) of a view that shows one folder at a time (Solutions'
 * header, the Codebase Memory strip): a dropdown of {@link FolderSwitch.options}
 * that reads as the view's mono text. With a single folder there is nothing to
 * switch to, so it renders nothing and the view keeps its pre-D14 look.
 */
export function FolderSwitcher({ state, testId, className = '' }: { readonly state: FolderSwitch; readonly testId: string; readonly className?: string }) {
  if (state.options.length < 2) return null;
  const value = state.selected?.value ?? state.param ?? '';
  return (
    <select
      className={`sb-folder-switch ${className}`.trim()}
      data-testid={testId}
      aria-label="Folder"
      title={state.selected?.path ?? state.param}
      value={value}
      onChange={(event) => state.select(event.target.value)}
    >
      {state.selected === null && state.param ? <option value={state.param}>{state.param}</option> : null}
      {state.options.map((option) => (
        <option key={option.value} value={option.value} title={option.path} data-saved={option.saved ? 'true' : 'false'}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** `true` when the view shows a switcher (two folders or more to choose from). */
export function hasSwitcher(state: FolderSwitch): boolean {
  return state.options.length > 1;
}
