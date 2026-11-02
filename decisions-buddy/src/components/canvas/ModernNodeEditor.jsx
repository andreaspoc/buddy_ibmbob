import React from 'react';
import { Button, Checkbox, Select, SelectItem, TextArea, TextInput, NumberInput } from '@carbon/react';
import { ACTION_TYPES, AGENDA_TYPES, TERM_TYPES } from '../../lib/modernNodes.js';

export default function ModernNodeEditor({ type, draft, onChange, joins = [] }) {
  const update = change => onChange({ ...draft, ...change });
  const isAction = ACTION_TYPES.includes(type), isAgenda = AGENDA_TYPES.includes(type);
  const changeRule = (index, change) => update({ rules: draft.rules.map((rule, i) => i === index ? { ...rule, ...change } : rule) });
  return <div>
    {isAction && <TextArea id="business-rule-source" labelText="Business action rule" rows={10} value={draft.source || ''} onChange={event => update({ source: event.target.value })} helperText="Use if … then … else, with set/add actions. Business terms below can replace JSON paths. Quoted text is preserved." />}
    {isAgenda && <>
      <Select id="agenda-conflict-resolution" labelText="Choose the next matching rule" value={draft.conflictResolution || 'priority'} onChange={event => update({ conflictResolution: event.target.value })}>
        <SelectItem value="priority" text="Highest priority first" />
        <SelectItem value="specificity" text="Highest priority, then most specific match" />
        <SelectItem value="recency" text="Highest priority, then most recently updated fact" />
      </Select>
      <NumberInput id="agenda-firing-limit" label="Maximum rule firings" min={1} max={500} value={draft.maxCycles ?? 50} onChange={(_, { value }) => update({ maxCycles: Number(value) })} />
      {(draft.rules || []).map((rule, index) => <fieldset key={index} className="decisions-mt-05 decisions-p-04">
        <legend>Rule {index + 1}</legend>
        <TextInput id={`agenda-id-${index}`} labelText="Rule identifier" value={rule.id || ''} onChange={event => changeRule(index, { id: event.target.value })} />
        <NumberInput id={`agenda-priority-${index}`} label="Priority" value={rule.priority ?? 0} onChange={(_, { value }) => changeRule(index, { priority: Number(value) })} />
        <TextInput id={`agenda-condition-${index}`} labelText="Condition" value={rule.condition ?? 'true'} onChange={event => changeRule(index, { condition: event.target.value })} />
        <TextArea id={`agenda-actions-${index}`} labelText="Actions" rows={4} value={rule.actionsText || ''} onChange={event => changeRule(index, { actionsText: event.target.value })} helperText="Semicolon-separated set/add statements, or a JSON array of structured fact actions." />
        <Checkbox id={`agenda-loopable-${index}`} labelText="Allow this rule to fire again after fact changes" checked={!!rule.loopable} onChange={(_, { checked }) => changeRule(index, { loopable: checked })} />
        <details><summary>Match facts in collections</summary>
          <TextArea id={`agenda-patterns-${index}`} labelText="Fact patterns" rows={5} value={rule.patternsText || '[]'} onChange={event => changeRule(index, { patternsText: event.target.value })} helperText={'Example: [{"collection":"facts.orders","as":"order","equals":{"status":"pending"},"where":"order.total > 100"}]'} />
          <p>Structured actions can update or retract a matched fact, or insert a new fact. For example: {JSON.stringify([{ op: 'update', fact: 'order', values: { approved: 'true' } }])}</p>
        </details>
        <Button kind="danger--ghost" size="sm" onClick={() => update({ rules: draft.rules.filter((_, i) => i !== index) })}>Remove rule {index + 1}</Button>
      </fieldset>)}
      <Button kind="tertiary" className="decisions-mt-04" onClick={() => update({ rules: [...(draft.rules || []), { id: `rule_${crypto.randomUUID()}`, priority: 0, condition: 'true', actionsText: '', patternsText: '[]' }] })}>Add rule</Button>
    </>}
    {(isAction || isAgenda) && <section className="decisions-mt-06">
      <h4>Business vocabulary</h4>
      <p>Map business phrases to JSON fields and their expected types. Required fields must exist before execution. These mappings are saved with this node.</p>
      {(draft.vocabulary || []).map((entry, index) => {
        const edit = change => update({ vocabulary: draft.vocabulary.map((item, i) => i === index ? { ...item, ...change } : item) });
        return <fieldset key={index} className="decisions-mt-04 decisions-p-04"><legend>Term {index + 1}</legend>
          <TextInput id={`term-name-${index}`} labelText="Business phrase" value={entry.term} onChange={event => edit({ term: event.target.value })} />
          <TextInput id={`term-path-${index}`} labelText="JSON field path" value={entry.path} onChange={event => edit({ path: event.target.value })} />
          <Select id={`term-type-${index}`} labelText="Value type" value={entry.type || 'any'} onChange={event => edit({ type: event.target.value })}>{TERM_TYPES.map(kind => <SelectItem key={kind} value={kind} text={kind} />)}</Select>
          <Checkbox id={`term-required-${index}`} labelText="Required input" checked={!!entry.required} onChange={(_, { checked }) => edit({ required: checked })} />
          <Button kind="danger--ghost" size="sm" onClick={() => update({ vocabulary: draft.vocabulary.filter((_, i) => i !== index) })}>Remove term {index + 1}</Button>
        </fieldset>;
      })}
      <Button kind="tertiary" className="decisions-mt-04" onClick={() => update({ vocabulary: [...(draft.vocabulary || []), { term: '', path: '', type: 'any', required: false }] })}>Add business term</Button>
    </section>}
    {type === 'forkNode' && <>
      <p>Branches run against isolated copies of the input. Connect each branch to the same join; overlapping branch writes follow that join’s merge policy.</p>
      <Select id="parallel-join-id" labelText="Matching join" value={draft.joinId || ''} onChange={event => update({ joinId: event.target.value })}>
        <SelectItem value="" text="Infer common join from connections" />
        {joins.map(join => <SelectItem key={join.id} value={join.id} text={`${join.data.name} (${join.id})`} />)}
      </Select>
      <NumberInput id="parallel-workers" label="Maximum parallel workers" value={draft.maxWorkers ?? 4} min={1} max={8} onChange={(_, { value }) => update({ maxWorkers: Number(value) })} />
    </>}
    {type === 'joinNode' && <Select id="parallel-merge-policy" labelText="When branches write different values to the same field" value={draft.mergePolicy || 'error'} onChange={event => update({ mergePolicy: event.target.value })}>
      <SelectItem value="error" text="Fail the decision with a merge conflict" />
      <SelectItem value="first" text="Use the first branch’s value" />
      <SelectItem value="last" text="Use the last branch’s value" />
    </Select>}
  </div>;
}
