import { describe, expect, it } from 'vitest';
import { defineWorkflow, isStepSatisfied, pathTo, resolveNext } from './definition';
import { testWorkflow } from './testing';

interface Data {
  templateId: string;
  parishId: string;
  needsSetup: boolean;
  body: string;
}

/** A branching flow: `parish` sends new parishes through an extra `setup` step. */
const flow = defineWorkflow<Data>({
  id: 'bulletin',
  initial: { templateId: '', parishId: '', needsSetup: false, body: '' },
  steps: {
    template: { route: 'template', validate: (d) => !!d.templateId, next: 'parish' },
    parish: {
      route: 'parish',
      validate: (d) => !!d.parishId,
      next: (d) => (d.needsSetup ? 'setup' : 'content'),
    },
    setup: { route: 'setup', next: 'content' },
    content: { route: 'content', validate: (d) => d.body.length > 0, next: 'review' },
    review: { route: 'review', terminal: true, submit: async () => 'published' },
  },
});

describe('defineWorkflow', () => {
  it('exposes step ids and the first step', () => {
    expect(flow.stepIds).toEqual(['template', 'parish', 'setup', 'content', 'review']);
    expect(flow.firstStep).toBe('template');
  });

  it('honours an explicit initialStep', () => {
    const f = defineWorkflow<{ a: string }>({
      id: 'x',
      initial: { a: '' },
      initialStep: 'second',
      steps: { first: { route: 'f', next: 'second' }, second: { route: 's', terminal: true } },
    });
    expect(f.firstStep).toBe('second');
  });

  it('rejects a transition to an unknown step at definition time', () => {
    expect(() =>
      defineWorkflow<{ a: string }>({
        id: 'bad',
        initial: { a: '' },
        steps: { one: { route: 'one', next: 'nowhere' } },
      }),
    ).toThrow(/unknown step "nowhere"/);
  });

  it('rejects a step that neither advances nor terminates', () => {
    expect(() =>
      defineWorkflow<{ a: string }>({
        id: 'bad',
        initial: { a: '' },
        steps: { one: { route: 'one' } },
      }),
    ).toThrow(/no `next` and is not `terminal`/);
  });

  it('rejects duplicate routes', () => {
    expect(() =>
      defineWorkflow<{ a: string }>({
        id: 'bad',
        initial: { a: '' },
        steps: {
          one: { route: 'same', next: 'two' },
          two: { route: 'same', terminal: true },
        },
      }),
    ).toThrow(/reuses route "same"/);
  });

  it('rejects an empty flow and a bad initialStep', () => {
    expect(() => defineWorkflow<{ a: string }>({ id: 'e', initial: { a: '' }, steps: {} })).toThrow();
    expect(() =>
      defineWorkflow<{ a: string }>({
        id: 'e',
        initial: { a: '' },
        initialStep: 'ghost',
        steps: { one: { route: 'one', terminal: true } },
      }),
    ).toThrow(/is not a declared step/);
  });

  it('treats a throwing validator as unsatisfied rather than crashing', () => {
    const f = defineWorkflow<{ a: string }>({
      id: 'throws',
      initial: { a: '' },
      steps: {
        one: {
          route: 'one',
          validate: () => {
            throw new Error('bad validator');
          },
          next: 'two',
        },
        two: { route: 'two', terminal: true },
      },
    });
    expect(isStepSatisfied(f, 'one', { a: '' })).toBe(false);
  });
});

describe('branching', () => {
  it('follows the branch the data selects', () => {
    const short = testWorkflow(flow, { templateId: 't', parishId: 'p', needsSetup: false });
    expect(resolveNext(flow, 'parish', short.data())).toBe('content');

    const long = testWorkflow(flow, { templateId: 't', parishId: 'p', needsSetup: true });
    expect(resolveNext(flow, 'parish', long.data())).toBe('setup');
  });

  it('returns null at a terminal step', () => {
    expect(resolveNext(flow, 'review', flow.initial)).toBeNull();
  });
});

describe('pathTo', () => {
  it('reports the blocking step for an unreachable target', () => {
    const result = pathTo(flow, 'content', flow.initial);
    expect(result.reachable).toBe(false);
    expect(result.blockedAt).toBe('template');
  });

  it('reports reachable once the prerequisites are satisfied', () => {
    const data = { templateId: 't', parishId: 'p', needsSetup: false, body: 'x' };
    expect(pathTo(flow, 'content', data).reachable).toBe(true);
  });

  it('reports a step on the untaken branch as unreachable', () => {
    const data = { templateId: 't', parishId: 'p', needsSetup: false, body: 'x' };
    // `setup` only exists on the needsSetup branch.
    expect(pathTo(flow, 'setup', data).reachable).toBe(false);
  });
});

describe('testWorkflow harness', () => {
  it('starts at the first step', () => {
    const run = testWorkflow(flow);
    expect(run.current()).toBe('template');
    expect(run.canAdvance()).toBe(false); // templateId is blank
  });

  it('advances once the step is satisfied', () => {
    const run = testWorkflow(flow).advance({ templateId: 'missale' });
    expect(run.current()).toBe('parish');
    expect(run.visited()).toEqual(['template', 'parish']);
  });

  it('refuses to advance past an unsatisfied step', () => {
    const run = testWorkflow(flow).advance();
    expect(run.current()).toBe('template');
  });

  it('takes the branch the data selects', () => {
    const short = testWorkflow(flow)
      .advance({ templateId: 't' })
      .advance({ parishId: 'p', needsSetup: false });
    expect(short.current()).toBe('content');

    const long = testWorkflow(flow)
      .advance({ templateId: 't' })
      .advance({ parishId: 'p', needsSetup: true });
    expect(long.current()).toBe('setup');
  });

  it('walks back through the visited trail', () => {
    const run = testWorkflow(flow).advance({ templateId: 't' }).back();
    expect(run.current()).toBe('template');
  });

  it('does not go back past the beginning', () => {
    expect(testWorkflow(flow).back().current()).toBe('template');
  });

  it('redirects a deep link into an unreachable step', () => {
    const run = testWorkflow(flow).goTo('review');
    // Nothing is filled in, so it lands on the first blocking step.
    expect(run.current()).toBe('template');
  });

  it('allows returning to an already-visited step', () => {
    const run = testWorkflow(flow)
      .advance({ templateId: 't' })
      .advance({ parishId: 'p' })
      .goTo('template');
    expect(run.current()).toBe('template');
  });

  it('ignores a jump to a step that does not exist', () => {
    const run = testWorkflow(flow).goTo('nonsense');
    expect(run.current()).toBe('template');
  });

  it('reports progress along the selected branch', () => {
    const run = testWorkflow(flow).advance({ templateId: 't' });
    const p = run.progress();
    expect(p.done).toBeGreaterThan(0);
    expect(p.percent).toBeGreaterThan(0);
    expect(p.percent).toBeLessThanOrEqual(100);
  });

  it('reports completion only when the whole branch is satisfied', () => {
    expect(testWorkflow(flow).isComplete()).toBe(false);
    const done = testWorkflow(flow, {
      templateId: 't',
      parishId: 'p',
      needsSetup: false,
      body: 'text',
    });
    expect(done.isComplete()).toBe(true);
  });

  it('jumps straight to a state with at()', () => {
    const run = testWorkflow(flow).at('content', { body: 'seeded' });
    expect(run.current()).toBe('content');
    expect(run.data().body).toBe('seeded');
  });

  it('rejects at() for an unknown step', () => {
    expect(() => testWorkflow(flow).at('ghost')).toThrow(TypeError);
  });

  it('mints a stable run id for idempotency', () => {
    const run = testWorkflow(flow);
    const id = run.runId();
    run.advance({ templateId: 't' }).patch({ body: 'x' });
    // The id must survive every transition — it is the key the terminal
    // submit uses to deduplicate retries.
    expect(run.runId()).toBe(id);
    expect(id).toContain('bulletin:');
  });

  it('gives different runs different ids', () => {
    expect(testWorkflow(flow).runId()).not.toBe(testWorkflow(flow).runId());
  });
});
