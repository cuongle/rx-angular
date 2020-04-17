// @Notice this part of the code is in the coalescing PR https://github.com/ngrx/platform/pull/2456
import { ChangeDetectorRef, ɵdetectChanges as detectChanges, ɵmarkDirty as markDirty, } from '@angular/core';
// import { generateFrames } from '../projections/generateFrames';
// import { coalesce } from '../operators/coalesce';
import { MonoTypeOperatorFunction, Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { coalesce, CoalesceConfig } from '../rxjs/operators';
import { generateFrames } from '../rxjs/observable';
import { apiZonePatched, getGlobalThis, isViewEngineIvy } from '@ts-etc';

/** A shared promise instance to cause a delay of one microtask */
let resolvedPromise: Promise<void> | null = null;

function getResolvedPromise(): Promise<void> {
  resolvedPromise =
    resolvedPromise || apiZonePatched('Promise')
    ? (getGlobalThis().__zone_symbol__Promise.resolve() as Promise<void>)
    : Promise.resolve();
  return resolvedPromise;
}

/*export function getZoneUnPatchedDurationSelector(): () => Observable<number> {
 return () => defer(() => from(getResolvedPromise()).pipe(mapTo(1)));
 }*/

export function getZoneUnPatchedDurationSelector(): () => Observable<number> {
  return () => generateFrames();
}

export interface StrategyFactoryConfig {
  component: any;
  cdRef: ChangeDetectorRef;
}

export interface CdStrategy<T> {
  behaviour: () => MonoTypeOperatorFunction<T>;
  render: () => void;
  name: string;
}

export const DEFAULT_STRATEGY_NAME = 'local';

export interface StrategySelection<U> {
  native: CdStrategy<U>;

  [key: string]: CdStrategy<U>;
}

export function getStrategies<T>(
  cfg: StrategyFactoryConfig
): StrategySelection<T> {
  return {
    native: createNativeStrategy<T>(cfg),
    noop: createNoopStrategy<T>(),
    global: createGlobalStrategy<T>(cfg),
    local: createLocalStrategy<T>(cfg)
  };
}

/**
 * Strategies
 *
 * - VE/I - Options for ViewEngine / Ivy
 * - mFC - `cdRef.markForCheck`
 * - dC - `cdRef.detectChanges`
 * - ɵMD - `ɵmarkDirty`
 * - ɵDC - `ɵdetectChanges`
 * - LV  - `LView`
 * - C - `Component`
 *
 * | Name        | ZoneLess VE/I | Render Method VE/I  | Coalescing VE/I  |
 * |-------------| --------------| ------------ ------ | ---------------- |
 * | `native`    | ❌/❌         | mFC / mFC           | ❌               |
 * | `global`    | ❌/✔️         | mFC  / ɵMD           | ❌              |
 * | `local`     | ✔️/✔️          | dC / ɵDC            | ✔️ + C/ LV       |
 * | `noop`      | ❌/❌         | no rendering        | ❌               |
 *
 */

/**
 * Native Strategy
 * @description
 *
 * This strategy mirrors Angular's built-in `async` pipe.
 * This means for every emitted value `ChangeDetectorRef#markForCheck` is called.
 *
 * | Name        | ZoneLess VE/I | Render Method VE/I  | Coalescing VE/I  |
 * |-------------| --------------| ------------ ------ | ---------------- |
 * | `native`    | ❌/❌         | mFC / mFC           | ❌               |
 *
 * @param config { StrategyFactoryConfig } - The values this strategy needs to get calculated.
 * @return {CdStrategy<T>} - The calculated strategy
 *
 */
export function createNativeStrategy<T>(
  config: StrategyFactoryConfig
): CdStrategy<T> {
  return {
    render: (): void => config.cdRef.markForCheck(),
    behaviour: () => o => o,
    name: 'native',
  };
}

/**
 * Noop Strategy
 *
 * This strategy is does nothing. It serves for debugging only
 *
 * | Name        | ZoneLess VE/I | Render Method VE/I  | Coalescing VE/I  |
 * |-------------| --------------| ------------ ------ | ---------------- |
 * | `noop`      | ❌/❌         | no rendering        | ❌               |
 *
 * @param config { StrategyFactoryConfig } - The values this strategy needs to get calculated.
 * @return {CdStrategy<T>} - The calculated strategy
 *
 */
export function createNoopStrategy<T>(cfg?: any): CdStrategy<T> {
  return {
    render: (): void => {},
    behaviour: () => o => o,
    name: 'noop',
  };
}

/**
 *
 * Global Strategy
 *
 * This strategy is rendering the application root and
 * all it's children that are on a path
 * that is marked as dirty or has components with `ChangeDetectionStrategy.Default`.
 *
 * | Name        | ZoneLess VE/I | Render Method VE/I  | Coalescing VE/I  |
 * |-------------| --------------| ------------ ------ | ---------------- |
 * | `global`    | ❌/✔️         | mFC / ɵMD           | ❌               |
 *
 * @param config { StrategyFactoryConfig } - The values this strategy needs to get calculated.
 * @return {CdStrategy<T>} - The calculated strategy
 *
 */
export function createGlobalStrategy<T>(
  cfg: StrategyFactoryConfig
): CdStrategy<T> {
  const inIvy = isViewEngineIvy();

  function render() {
    if (!inIvy) {
      cfg.cdRef.markForCheck();
    } else {
      markDirty(cfg.component);
    }
  }

  const behaviour = () => (o$: Observable<T>): Observable<T> => o$;

  return {
    behaviour,
    render,
    name: 'global',
  };
}

/**
 *  Local Strategy
 *
 * This strategy is rendering the actual component and
 * all it's children that are on a path
 * that is marked as dirty or has components with `ChangeDetectionStrategy.Default`.
 *
 * As detectChanges has no coalescing of render calls
 * like `ChangeDetectorRef#markForCheck` or `ɵmarkDirty` has, so we have to apply our own coalescing, 'scoped' on
 * component level.
 *
 * Coalescing, in this very manner,
 * means **collecting all events** in the same
 * [EventLoop](https://developer.mozilla.org/de/docs/Web/JavaScript/EventLoop) tick, that would cause a re-render and
 * execute **re-rendering only once**.
 *
 * 'Scoped' coalescing, in addition, means **grouping the collected events by** a specific context.
 * E. g. the **component** from which the re-rendering was initiated.
 *
 * | Name        | ZoneLess VE/I | Render Method VE/I  | Coalescing VE/I  |
 * |-------------| --------------| ------------ ------ | ---------------- |
 * | `local`     | ✔️/✔️          | dC / ɵDC            | ✔️ + C/ LV       |
 *
 * @param config { StrategyFactoryConfig } - The values this strategy needs to get calculated.
 * @return {CdStrategy<T>} - The calculated strategy
 *
 */
export function createLocalStrategy<T>(
  cfg: StrategyFactoryConfig
): CdStrategy<T> {
  const inIvy = isViewEngineIvy();
  const durationSelector = getZoneUnPatchedDurationSelector();
  const coalesceConfig: CoalesceConfig = {
    context: (inIvy
              ? (cfg.cdRef as any)._lView
              : (cfg.cdRef as any).context) as any,
  };

  function render() {
    if (!inIvy) {
      cfg.cdRef.detectChanges();
    } else {
      detectChanges(cfg.component);
    }
  }

  const behaviour = () => (o$: Observable<T>): Observable<T> => {
    return o$
      .pipe(coalesce(durationSelector, coalesceConfig));
  };

  return {
    behaviour,
    render,
    name: 'local',
  };
}
