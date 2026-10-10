import React, { useEffect, useMemo, useState } from 'react';
import { FileQuestion, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { t, presentError, statusLabel, categoryLabel } from '../i18n';
import SourcingEvaluation from './SourcingEvaluation';
import SourcingAward from './SourcingAward';
import { formatMoney, moneyInputProps, parseMajorAmount, toCents, formatMajorInput } from '../money';

const CATEGORIES = [
  'IT Hardware',
  'Software & Cloud',
  'Office Supplies',
  'Facilities & MRO',
  'Consulting & Professional Services',
  'Marketing & Events',
  'Travel & Subscriptions'
];

const FILTERS = ['all', 'draft', 'published', 'closed', 'evaluated', 'awarded', 'cancelled'];

function formatAmsterdam(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function amsterdamInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function blankLine() {
  return {
    description: '',
    category: 'Office Supplies',
    quantity: 1,
    unit_of_measure: 'each',
    line_type: 'goods',
    service_basis: '',
    target: ''
  };
}

function blankDraft(departmentId) {
  return {
    id: null,
    row_version: null,
    title: '',
    description: '',
    category: '',
    department_id: departmentId || '',
    source: 'scratch',
    requisition_id: '',
    spec_only: false,
    lines: [blankLine()],
    invitations: [],
    deadline: '',
    qa_enabled: false,
    qa_deadline: '',
    weight_price: 70,
    weight_lead_time: 15,
    weight_quality: 15,
    evaluator_ids: []
  };
}

function centsFromInput(text) {
  if (text == null || String(text).trim() === '') return null;
  if (parseMajorAmount(text) == null) return undefined;
  return toCents(text);
}

function eventToDraft(event) {
  return {
    id: event.id,
    row_version: event.row_version,
    title: event.title || '',
    description: event.description || '',
    category: event.category || '',
    department_id: event.department_id || '',
    source: event.source_requisition_id ? 'requisition' : 'scratch',
    requisition_id: event.source_requisition_id || '',
    spec_only: event.lines?.length === 1 && event.lines[0].description === 'Totaalprijs volgens specificatie',
    lines: (event.lines || []).map((line) => ({
      description: line.description,
      category: line.category,
      quantity: line.quantity,
      unit_of_measure: line.unit_of_measure || 'each',
      line_type: line.line_type || 'goods',
      service_basis: line.service_basis || '',
      target: line.target_unit_price_cents == null ? '' : formatMajorInput(line.target_unit_price_cents)
    })),
    invitations: (event.invitations || []).map((row) => ({
      supplier_id: row.supplier_id,
      contact_name: row.contact_name || '',
      contact_email: row.contact_email || ''
    })),
    deadline: amsterdamInputValue(event.deadline_at),
    qa_enabled: Boolean(event.qa_enabled),
    qa_deadline: amsterdamInputValue(event.qa_deadline_at),
    weight_price: event.weight_price,
    weight_lead_time: event.weight_lead_time,
    weight_quality: event.weight_quality,
    evaluator_ids: (event.evaluators || []).map((row) => row.user_id)
  };
}

export default function SourcingView({ currentUser, navFocus, onNavigate }) {
  const canWrite = currentUser?.role === 'procurement' || currentUser?.role === 'admin';
  const [screen, setScreen] = useState('list');
  const [filter, setFilter] = useState('all');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => blankDraft(currentUser?.department_id));
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('overview');
  const [saving, setSaving] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [departments, setDepartments] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [users, setUsers] = useState([]);
  const [approved, setApproved] = useState([]);
  const [supplierQuery, setSupplierQuery] = useState('');
  const [pickedSupplier, setPickedSupplier] = useState('');
  const [linkNotice, setLinkNotice] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answerText, setAnswerText] = useState('');
  const [answerVisibility, setAnswerVisibility] = useState('private');
  const [extendValue, setExtendValue] = useState('');
  const [revokeReason, setRevokeReason] = useState('');

  const loadList = async (status = filter) => {
    setLoading(true);
    setError('');
    try {
      const rows = await api.listSourcingEvents(status === 'all' ? {} : { status });
      setEvents(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(presentError(err, 'errors.sourcing'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadList(filter);
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getDepartments().catch(() => []),
      api.getSuppliers().catch(() => []),
      api.getUsers('active').catch(() => []),
      api.getRequisitions('approved').catch(() => [])
    ]).then(([depts, sups, people, prs]) => {
      if (cancelled) return;
      setDepartments(Array.isArray(depts) ? depts : []);
      setSuppliers(Array.isArray(sups) ? sups.filter((row) => !row.status || row.status === 'active') : []);
      setUsers(Array.isArray(people) ? people.filter((row) => row.status !== 'inactive') : []);
      setApproved(Array.isArray(prs) ? prs : []);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!navFocus?.requisitionId || !canWrite) return;
    setDraft({
      ...blankDraft(currentUser?.department_id),
      source: 'requisition',
      requisition_id: navFocus.requisitionId
    });
    setScreen('editor');
    setError('');
  }, [navFocus?.requisitionId]);

  const weightSum = Number(draft.weight_price) + Number(draft.weight_lead_time) + Number(draft.weight_quality);
  const supplierChoices = useMemo(() => {
    const query = supplierQuery.trim().toLowerCase();
    return suppliers.filter((row) => {
      if (draft.invitations.some((item) => Number(item.supplier_id) === Number(row.id))) return false;
      if (!query) return true;
      return `${row.name} ${row.code}`.toLowerCase().includes(query);
    });
  }, [suppliers, supplierQuery, draft.invitations]);

  const openDetail = async (id) => {
    setError('');
    setLoading(true);
    try {
      const event = await api.getSourcingEvent(id);
      setDetail(event);
      setTab('overview');
      setCancelReason('');
      setLinkNotice([]);
      setComparison(null);
      setScreen('detail');
    } catch (err) {
      setError(presentError(err, 'errors.sourcing'));
    } finally {
      setLoading(false);
    }
  };

  const buildPayload = () => {
    const payload = {
      title: draft.title.trim(),
      description: draft.description,
      category: draft.category || null,
      department_id: draft.department_id ? Number(draft.department_id) : null,
      deadline_at: draft.deadline || null,
      qa_enabled: draft.qa_enabled,
      qa_deadline_at: draft.qa_enabled ? (draft.qa_deadline || null) : null,
      weight_price: Number(draft.weight_price),
      weight_lead_time: Number(draft.weight_lead_time),
      weight_quality: Number(draft.weight_quality),
      evaluators: draft.evaluator_ids,
      invitations: draft.invitations.map((row) => ({
        supplier_id: Number(row.supplier_id),
        contact_name: row.contact_name,
        contact_email: row.contact_email
      }))
    };
    if (draft.spec_only) {
      payload.spec_only = true;
      payload.category = draft.category;
      const target = centsFromInput(draft.lines[0]?.target);
      if (target === undefined) return { error: t('sourcing.amountInvalid') };
      if (target != null) payload.target_unit_price_cents = target;
    } else {
      const lines = [];
      for (const line of draft.lines) {
        const target = centsFromInput(line.target);
        if (target === undefined) return { error: t('sourcing.amountInvalid') };
        lines.push({
          description: line.description,
          category: line.category,
          quantity: Number(line.quantity),
          unit_of_measure: line.unit_of_measure || 'each',
          line_type: line.line_type,
          service_basis: line.line_type === 'service' ? (line.service_basis || null) : null,
          target_unit_price_cents: target
        });
      }
      payload.lines = lines;
    }
    if (draft.id) payload.row_version = draft.row_version;
    return { payload };
  };

  const save = async () => {
    if (weightSum !== 100) {
      setError(t('sourcing.weightsInvalid'));
      return;
    }
    const built = buildPayload();
    if (built.error) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError('');
    try {
      let saved;
      if (draft.id) {
        saved = await api.updateSourcingEvent(draft.id, built.payload);
      } else if (draft.source === 'requisition') {
        saved = await api.createSourcingEventFromRequisition({
          ...built.payload,
          requisition_id: Number(draft.requisition_id)
        });
      } else {
        saved = await api.createSourcingEvent(built.payload);
      }
      setDetail(saved);
      setTab('overview');
      setScreen('detail');
      await loadList(filter);
    } catch (err) {
      setError(presentError(err, 'errors.sourcingSave'));
    } finally {
      setSaving(false);
    }
  };

  const uploadFile = async (file) => {
    if (!detail?.id || !file) return;
    setError('');
    try {
      await api.uploadSourcingFile(detail.id, file);
      setDetail(await api.getSourcingEvent(detail.id));
    } catch (err) {
      setError(presentError(err, 'errors.sourcingFile'));
    }
  };

  const removeFile = async (fileId) => {
    setError('');
    try {
      await api.removeSourcingFile(detail.id, fileId);
      setDetail(await api.getSourcingEvent(detail.id));
    } catch (err) {
      setError(presentError(err, 'errors.sourcingFile'));
    }
  };

  const cancelEvent = async () => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.cancelSourcingEvent(detail.id, cancelReason);
      setDetail(saved);
      await loadList(filter);
    } catch (err) {
      setError(presentError(err, 'errors.sourcingSave'));
    } finally {
      setSaving(false);
    }
  };

  const isOwner = currentUser?.role === 'admin' || Number(detail?.owner_user_id) === Number(currentUser?.id);
  const ownerCanEdit = canWrite && detail?.status === 'draft' && isOwner;
  const ownerCanManage = canWrite && (detail?.status === 'draft' || detail?.status === 'published') && isOwner;
  // Cancel is also possible after the deadline (closed, evaluated); a pending award is withdrawn with it.
  const canCancel = canWrite && isOwner && ['draft', 'published', 'closed', 'evaluated'].includes(detail?.status);

  const publish = async (source = detail) => {
    if (!source?.id) return;
    setSaving(true);
    setError('');
    try {
      const saved = await api.publishSourcingEvent(source.id, { row_version: source.row_version });
      setDetail(saved);
      setLinkNotice((saved.invitations || []).filter((row) => row.portal_url));
      setScreen('detail');
      setTab('suppliers');
      await loadList(filter);
    } catch (err) {
      setError(presentError(err, 'errors.sourcingSave'));
    } finally {
      setSaving(false);
    }
  };

  const openTab = async (key) => {
    setTab(key);
    if (!detail?.id) return;
    try {
      if (key === 'comparison' || key === 'award') setComparison(await api.getSourcingComparison(detail.id));
      if (key === 'qa') setQuestions(await api.listSourcingQuestions(detail.id) || []);
    } catch (err) {
      setError(presentError(err, 'errors.sourcing'));
    }
  };

  const rotateLink = async (invitation) => {
    setError('');
    try {
      const saved = await api.rotateSourcingLink(detail.id, invitation.id);
      setLinkNotice([{ ...invitation, portal_url: saved.portal_url }]);
      setDetail(await api.getSourcingEvent(detail.id));
    } catch (err) {
      setError(presentError(err, 'errors.sourcingSave'));
    }
  };

  const revokeLink = async (invitationId) => {
    setError('');
    try {
      await api.revokeSourcingLink(detail.id, invitationId, revokeReason);
      setRevokeReason('');
      setDetail(await api.getSourcingEvent(detail.id));
    } catch (err) {
      setError(presentError(err, 'errors.sourcingSave'));
    }
  };

  const extendDeadline = async () => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.extendSourcingDeadline(detail.id, {
        row_version: detail.row_version,
        deadline_at: extendValue
      });
      setDetail(saved);
      setExtendValue('');
    } catch (err) {
      setError(presentError(err, 'errors.sourcingSave'));
    } finally {
      setSaving(false);
    }
  };

  const answerQuestion = async (questionId) => {
    setError('');
    try {
      await api.answerSourcingQuestion(detail.id, questionId, {
        answer: answerText,
        visibility: answerVisibility
      });
      setAnswerText('');
      setQuestions(await api.listSourcingQuestions(detail.id));
    } catch (err) {
      setError(presentError(err, 'errors.sourcingSave'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FileQuestion className="w-6 h-6 text-indigo-600" />
            {t('sourcing.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t('sourcing.subtitle')}</p>
        </div>
        {screen === 'list' && canWrite && (
          <button
            type="button"
            onClick={() => {
              setDraft(blankDraft(currentUser?.department_id));
              setError('');
              setScreen('editor');
            }}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold"
          >
            {t('sourcing.new')}
          </button>
        )}
        {screen !== 'list' && (
          <button
            type="button"
            onClick={() => { setScreen('list'); setError(''); loadList(filter); }}
            className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-semibold text-slate-700"
          >
            {t('sourcing.back')}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
      )}

      {screen === 'list' && (
        <>
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-2 py-1 rounded-full text-xs font-semibold ${filter === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
              >
                {key === 'all' ? t('sourcing.filter.all') : statusLabel(key)}
              </button>
            ))}
          </div>
          {loading ? (
            <p className="text-sm text-slate-500">{t('common.loading')}</p>
          ) : events.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
              <p className="font-semibold text-slate-800">{t('sourcing.empty.title')}</p>
              <p className="text-sm text-slate-500 mt-1">{t('sourcing.empty.body')}</p>
              <div className="mt-4 flex justify-center gap-2">
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => { setDraft(blankDraft(currentUser?.department_id)); setScreen('editor'); }}
                    className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold"
                  >
                    {t('sourcing.new')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onNavigate?.('requisitions')}
                  className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-semibold"
                >
                  {t('sourcing.empty.toRequisitions')}
                </button>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">{t('sourcing.col.number')}</th>
                    <th className="px-4 py-3">{t('sourcing.col.title')}</th>
                    <th className="px-4 py-3">{t('sourcing.col.status')}</th>
                    <th className="px-4 py-3">{t('sourcing.col.deadline')}</th>
                    <th className="px-4 py-3">{t('sourcing.col.invited')}</th>
                    <th className="px-4 py-3">{t('sourcing.col.submitted')}</th>
                    <th className="px-4 py-3">{t('sourcing.col.owner')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr
                      key={event.id}
                      className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={() => openDetail(event.id)}
                    >
                      <td className="px-4 py-3 font-mono text-xs">{event.event_number}</td>
                      <td className="px-4 py-3 font-medium text-slate-800">{event.title}</td>
                      <td className="px-4 py-3">{statusLabel(event.status)}</td>
                      <td className="px-4 py-3">{formatAmsterdam(event.deadline_at)}</td>
                      <td className="px-4 py-3">{event.invitation_count}</td>
                      <td className="px-4 py-3">{event.submitted_count}</td>
                      <td className="px-4 py-3">{event.owner_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {screen === 'editor' && (
        <form
          className="space-y-4"
          onSubmit={(event) => { event.preventDefault(); save(); }}
        >
          <details open className="rounded-xl border border-slate-200 bg-white p-4">
            <summary className="font-semibold text-slate-800 cursor-pointer">{t('sourcing.section.basis')}</summary>
            <div className="grid md:grid-cols-2 gap-4 mt-4">
              <label className="block text-sm">
                <span className="text-slate-600">{t('sourcing.field.title')}</span>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  required
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">{t('sourcing.field.category')}</span>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                >
                  <option value="">{t('common.none')}</option>
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>{categoryLabel(category)}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm md:col-span-2">
                <span className="text-slate-600">{t('sourcing.field.description')}</span>
                <textarea
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 min-h-24"
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">{t('sourcing.field.department')}</span>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 disabled:bg-slate-50 disabled:text-slate-500"
                  value={draft.department_id}
                  disabled={draft.source === 'requisition'}
                  onChange={(event) => setDraft({ ...draft, department_id: event.target.value })}
                >
                  <option value="">{t('common.none')}</option>
                  {departments.map((dept) => (
                    <option key={dept.id} value={dept.id}>{dept.name}</option>
                  ))}
                </select>
              </label>
              {!draft.id && (
                <label className="block text-sm">
                  <span className="text-slate-600">{t('sourcing.field.source')}</span>
                  <select
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                    value={draft.source}
                    onChange={(event) => setDraft({ ...draft, source: event.target.value })}
                  >
                    <option value="scratch">{t('sourcing.source.scratch')}</option>
                    <option value="requisition">{t('sourcing.source.requisition')}</option>
                  </select>
                </label>
              )}
              {!draft.id && draft.source === 'requisition' && (
                <label className="block text-sm md:col-span-2">
                  <span className="text-slate-600">{t('sourcing.field.requisition')}</span>
                  <select
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                    value={draft.requisition_id}
                    onChange={(event) => setDraft({ ...draft, requisition_id: event.target.value })}
                    required
                  >
                    <option value="">{t('common.none')}</option>
                    {approved.map((pr) => (
                      <option key={pr.id} value={pr.id}>{pr.pr_number} — {pr.justification || pr.pr_number}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </details>

          {draft.source !== 'requisition' && (
            <details open className="rounded-xl border border-slate-200 bg-white p-4">
              <summary className="font-semibold text-slate-800 cursor-pointer">{t('sourcing.section.lines')}</summary>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={draft.spec_only}
                  onChange={(event) => setDraft({ ...draft, spec_only: event.target.checked })}
                />
                {t('sourcing.specOnly')}
              </label>
              {!draft.spec_only && (
                <div className="mt-4 space-y-3">
                  {draft.lines.map((line, index) => (
                    <div key={index} className="grid md:grid-cols-6 gap-2 items-end border-t border-slate-100 pt-3">
                      <label className="md:col-span-2 text-xs text-slate-600">
                        {t('common.description')}
                        <input
                          className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
                          value={line.description}
                          onChange={(event) => {
                            const lines = [...draft.lines];
                            lines[index] = { ...line, description: event.target.value };
                            setDraft({ ...draft, lines });
                          }}
                        />
                      </label>
                      <label className="text-xs text-slate-600">
                        {t('sourcing.field.quantity')}
                        <input
                          type="number"
                          min="1"
                          className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
                          value={line.quantity}
                          onChange={(event) => {
                            const lines = [...draft.lines];
                            lines[index] = { ...line, quantity: event.target.value };
                            setDraft({ ...draft, lines });
                          }}
                        />
                      </label>
                      <label className="text-xs text-slate-600">
                        {t('sourcing.field.lineType')}
                        <select
                          className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
                          value={line.line_type}
                          onChange={(event) => {
                            const lines = [...draft.lines];
                            lines[index] = { ...line, line_type: event.target.value };
                            setDraft({ ...draft, lines });
                          }}
                        >
                          <option value="goods">{t('sourcing.line.goods')}</option>
                          <option value="service">{t('sourcing.line.service')}</option>
                        </select>
                      </label>
                      <label className="text-xs text-slate-600">
                        {t('sourcing.field.target')}
                        <input
                          {...moneyInputProps}
                          className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
                          value={line.target}
                          onChange={(event) => {
                            const lines = [...draft.lines];
                            lines[index] = { ...line, target: event.target.value };
                            setDraft({ ...draft, lines });
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="text-xs text-rose-700"
                        onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, i) => i !== index) })}
                      >
                        <Trash2 className="w-4 h-4 inline" /> {t('sourcing.line.remove')}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="text-sm font-semibold text-indigo-700"
                    onClick={() => setDraft({ ...draft, lines: [...draft.lines, blankLine()] })}
                  >
                    <Plus className="w-4 h-4 inline" /> {t('sourcing.line.add')}
                  </button>
                </div>
              )}
              {draft.spec_only && (
                <label className="mt-3 block text-sm text-slate-600">
                  {t('sourcing.field.target')}
                  <input
                    {...moneyInputProps}
                    className="mt-1 w-full max-w-xs rounded border border-slate-200 px-2 py-1.5"
                    value={draft.lines[0]?.target || ''}
                    onChange={(event) => setDraft({
                      ...draft,
                      lines: [{ ...(draft.lines[0] || blankLine()), target: event.target.value }]
                    })}
                  />
                </label>
              )}
            </details>
          )}

          <details open className="rounded-xl border border-slate-200 bg-white p-4">
            <summary className="font-semibold text-slate-800 cursor-pointer">{t('sourcing.section.suppliers')}</summary>
            <p className="text-xs text-slate-500 mt-2">{t('sourcing.supplier.hint')}</p>
            <div className="mt-3 flex flex-wrap gap-2 items-end">
              <label className="text-xs text-slate-600">
                {t('sourcing.supplier.search')}
                <input
                  className="mt-1 block rounded border border-slate-200 px-2 py-1.5 text-sm"
                  value={supplierQuery}
                  onChange={(event) => setSupplierQuery(event.target.value)}
                />
              </label>
              <select
                className="rounded border border-slate-200 px-2 py-1.5 text-sm"
                value={pickedSupplier}
                onChange={(event) => setPickedSupplier(event.target.value)}
              >
                <option value="">{t('common.none')}</option>
                {supplierChoices.map((row) => (
                  <option key={row.id} value={row.id}>{row.name} ({row.code})</option>
                ))}
              </select>
              <button
                type="button"
                className="px-3 py-1.5 bg-slate-900 text-white rounded text-sm"
                onClick={() => {
                  const supplier = suppliers.find((row) => Number(row.id) === Number(pickedSupplier));
                  if (!supplier) return;
                  setDraft({
                    ...draft,
                    invitations: [...draft.invitations, {
                      supplier_id: supplier.id,
                      contact_name: supplier.contact_person || '',
                      contact_email: supplier.email || ''
                    }]
                  });
                  setPickedSupplier('');
                }}
              >
                {t('sourcing.supplier.add')}
              </button>
            </div>
            {draft.invitations.length === 0 ? (
              <p className="text-sm text-slate-500 mt-3">{t('sourcing.supplier.empty')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {draft.invitations.map((row) => {
                  const supplier = suppliers.find((item) => Number(item.id) === Number(row.supplier_id));
                  return (
                    <li key={row.supplier_id} className="py-2 flex flex-wrap gap-2 items-center text-sm">
                      <span className="font-medium">{supplier?.name || row.supplier_id}</span>
                      <input
                        className="rounded border border-slate-200 px-2 py-1"
                        placeholder={t('sourcing.supplier.contact')}
                        value={row.contact_name}
                        onChange={(event) => setDraft({
                          ...draft,
                          invitations: draft.invitations.map((item) => (
                            item.supplier_id === row.supplier_id ? { ...item, contact_name: event.target.value } : item
                          ))
                        })}
                      />
                      <input
                        className="rounded border border-slate-200 px-2 py-1"
                        placeholder={t('sourcing.supplier.email')}
                        value={row.contact_email}
                        onChange={(event) => setDraft({
                          ...draft,
                          invitations: draft.invitations.map((item) => (
                            item.supplier_id === row.supplier_id ? { ...item, contact_email: event.target.value } : item
                          ))
                        })}
                      />
                      <button
                        type="button"
                        className="text-rose-700 text-xs"
                        onClick={() => setDraft({
                          ...draft,
                          invitations: draft.invitations.filter((item) => item.supplier_id !== row.supplier_id)
                        })}
                      >
                        {t('sourcing.supplier.remove')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </details>

          <details open className="rounded-xl border border-slate-200 bg-white p-4">
            <summary className="font-semibold text-slate-800 cursor-pointer">{t('sourcing.section.plan')}</summary>
            <div className="grid md:grid-cols-2 gap-4 mt-4">
              <label className="text-sm text-slate-600">
                {t('sourcing.deadline')} <span className="text-xs">({t('sourcing.deadlineZone')})</span>
                <input
                  type="datetime-local"
                  className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5"
                  value={draft.deadline}
                  onChange={(event) => setDraft({ ...draft, deadline: event.target.value })}
                />
              </label>
              <label className="text-sm text-slate-700 flex items-center gap-2 mt-6">
                <input
                  type="checkbox"
                  checked={draft.qa_enabled}
                  onChange={(event) => setDraft({ ...draft, qa_enabled: event.target.checked })}
                />
                {t('sourcing.qa.enabled')}
              </label>
              {draft.qa_enabled && (
                <label className="text-sm text-slate-600">
                  {t('sourcing.qa.deadline')}
                  <input
                    type="datetime-local"
                    className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5"
                    value={draft.qa_deadline}
                    onChange={(event) => setDraft({ ...draft, qa_deadline: event.target.value })}
                  />
                </label>
              )}
            </div>
            <p className="text-sm text-slate-600 mt-4">{t('sourcing.weights')}</p>
            <div className="grid grid-cols-3 gap-2 max-w-md mt-2">
              {[
                ['weight_price', 'sourcing.weights.price'],
                ['weight_lead_time', 'sourcing.weights.lead'],
                ['weight_quality', 'sourcing.weights.quality']
              ].map(([key, label]) => (
                <label key={key} className="text-xs text-slate-600">
                  {t(label)}
                  <input
                    type="number"
                    min="0"
                    max="100"
                    className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
                    value={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </label>
              ))}
            </div>
            <p className={`text-xs mt-2 ${weightSum === 100 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {t('sourcing.weights.sum')} ({weightSum}%)
            </p>
            <p className="text-sm text-slate-600 mt-4">{t('sourcing.evaluators')}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              {users.map((user) => (
                <label key={user.id} className="text-sm text-slate-700 flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={draft.evaluator_ids.some((id) => Number(id) === Number(user.id))}
                    onChange={(event) => {
                      const ids = event.target.checked
                        ? [...draft.evaluator_ids, user.id]
                        : draft.evaluator_ids.filter((id) => Number(id) !== Number(user.id));
                      setDraft({ ...draft, evaluator_ids: ids });
                    }}
                  />
                  {user.name}
                </label>
              ))}
            </div>
          </details>

          <details className="rounded-xl border border-slate-200 bg-white p-4">
            <summary className="font-semibold text-slate-800 cursor-pointer">{t('sourcing.section.files')}</summary>
            <p className="text-sm text-slate-500 mt-2">{t('sourcing.files.afterSave')}</p>
          </details>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h2 className="font-semibold text-slate-800">{t('sourcing.section.review')}</h2>
            <p className="text-sm text-slate-600 mt-1">{t('sourcing.publishNote')}</p>
            <div className="mt-3 flex flex-wrap gap-2 items-center">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60"
              >
                {saving ? t('common.saving') : t('sourcing.save')}
              </button>
              <button
                type="button"
                disabled={!draft.id || saving}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-60"
                title={draft.id ? t('sourcing.publish') : t('sourcing.publishLater')}
                onClick={() => publish(draft)}
              >
                {t('sourcing.publish')}
              </button>
              {!draft.id && <span className="text-xs text-slate-500">{t('sourcing.publishLater')}</span>}
            </div>
          </section>
        </form>
      )}

      {screen === 'detail' && detail && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-xs text-slate-500">{detail.event_number}</p>
              <h2 className="text-xl font-bold text-slate-900">{detail.title}</h2>
              <p className="text-sm text-slate-500">{statusLabel(detail.status)} · {formatAmsterdam(detail.deadline_at)}</p>
            </div>
            {ownerCanEdit && (
              <button
                type="button"
                className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-semibold"
                onClick={() => { setDraft(eventToDraft(detail)); setScreen('editor'); }}
              >
                {t('common.edit')}
              </button>
            )}
          </div>
          {!ownerCanEdit && detail.status === 'draft' && (
            <p className="text-sm text-slate-500">{t('sourcing.readOnly')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {[
              ['overview', 'sourcing.tab.overview'],
              ['lines', 'sourcing.tab.lines'],
              ['suppliers', 'sourcing.tab.suppliers'],
              ['files', 'sourcing.tab.files'],
              ['comparison', 'sourcing.tab.comparison'],
              ['award', 'sourcing.tab.award'],
              ['qa', 'sourcing.tab.qa'],
              ['history', 'sourcing.tab.history']
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => openTab(key)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold ${tab === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200'}`}
              >
                {t(label)}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
              {detail.warnings?.includes('deadline_in_the_past') && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                  {t('sourcing.warning.deadlinePast')}
                </p>
              )}
              {detail.warnings?.includes('few_invitations') && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                  {t('sourcing.warning.few')}
                </p>
              )}
              {ownerCanEdit && (
                <button type="button" disabled={saving} onClick={() => publish(detail)} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold">
                  {t('sourcing.publishNow')}
                </button>
              )}
              {ownerCanManage && detail.status === 'published' && (
                <div className="flex flex-wrap gap-2 items-end pt-2">
                  <label className="text-sm">
                    {t('sourcing.extend')}
                    <input type="datetime-local" className="mt-1 block rounded border border-slate-200 px-2 py-1.5" value={extendValue} onChange={(event) => setExtendValue(event.target.value)} />
                  </label>
                  <button type="button" disabled={saving || !extendValue} onClick={extendDeadline} className="px-3 py-2 border border-slate-300 rounded-lg text-sm">
                    {t('sourcing.extend')}
                  </button>
                </div>
              )}
              <p>{detail.description || t('common.none')}</p>
              <p>{t('sourcing.field.category')}: {detail.category ? categoryLabel(detail.category) : t('common.none')}</p>
              <p>{t('sourcing.field.department')}: {detail.department_name}</p>
              <p>{t('sourcing.col.owner')}: {detail.owner_name}</p>
              {detail.source_pr_number && <p>{detail.source_pr_number}</p>}
              <p>{t('sourcing.weights')}: {detail.weight_price} / {detail.weight_lead_time} / {detail.weight_quality}</p>
              <p>
                {t('sourcing.field.target')}: {detail.target_total_cents == null ? t('common.none') : formatMoney(detail.target_total_cents)}
              </p>
              {detail.status === 'cancelled' && <p>{t('common.reason')}: {detail.cancel_reason}</p>}
            </div>
          )}

          {tab === 'lines' && (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">{t('common.description')}</th>
                    <th className="px-3 py-2">{t('sourcing.field.quantity')}</th>
                    <th className="px-3 py-2">{t('sourcing.field.unit')}</th>
                    <th className="px-3 py-2">{t('sourcing.field.lineType')}</th>
                    <th className="px-3 py-2">{t('sourcing.field.target')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line) => (
                    <tr key={line.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{line.line_no}</td>
                      <td className="px-3 py-2">{line.description}</td>
                      <td className="px-3 py-2">{line.quantity}</td>
                      <td className="px-3 py-2">{line.unit_of_measure}</td>
                      <td className="px-3 py-2">
                        {line.line_type === 'service' ? t('sourcing.line.service') : t('sourcing.line.goods')}
                        {line.service_basis === 'lump_sum' ? ` · ${t('sourcing.basis.lump')}` : ''}
                        {line.service_basis === 'hours' ? ` · ${t('sourcing.basis.hours')}` : ''}
                        {line.service_basis === 'days' ? ` · ${t('sourcing.basis.days')}` : ''}
                      </td>
                      <td className="px-3 py-2">
                        {line.target_unit_price_cents == null ? t('common.none') : formatMoney(line.target_unit_price_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'suppliers' && (
            <div className="space-y-3">
              {linkNotice.length > 0 && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm space-y-2">
                  <p className="font-semibold">{t('sourcing.links.title')}</p>
                  <p>{t('sourcing.links.body')}</p>
                  {linkNotice.map((row) => (
                    <label key={row.id} className="block">
                      {row.supplier_name || row.contact_email}
                      <input readOnly className="mt-1 w-full rounded border border-indigo-200 bg-white px-2 py-1.5 font-mono text-xs" value={row.portal_url} />
                    </label>
                  ))}
                </div>
              )}
              <ul className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                {detail.invitations.length === 0 && (
                  <li className="px-4 py-3 text-sm text-slate-500">{t('sourcing.supplier.empty')}</li>
                )}
                {detail.invitations.map((row) => (
                  <li key={row.id} className="px-4 py-3 text-sm space-y-2">
                    <p>
                      <span className="font-medium">{row.supplier_name}</span>
                      <span className="text-slate-500"> · {row.contact_name || t('common.none')} · {row.contact_email}</span>
                    </p>
                    {row.portal_status && (
                      <p className="text-slate-600">
                        {t(`sourcing.portalStatus.${row.portal_status}`)}
                        {row.submitted_at ? ` · ${formatAmsterdam(row.submitted_at)}` : ''}
                        {` · ${t('sourcing.comparison.revision')} ${row.revision_count || 0}`}
                        {` · ${t('sourcing.comparison.files')} ${row.attachment_count || 0}`}
                      </p>
                    )}
                    {ownerCanManage && detail.status === 'published' && !row.revoked_at && (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="text-indigo-700 font-semibold" onClick={() => rotateLink(row)}>{t('sourcing.links.rotate')}</button>
                        <button type="button" className="text-rose-700" onClick={() => revokeLink(row.id)}>{t('sourcing.links.revoke')}</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {ownerCanManage && detail.status === 'published' && (
                <label className="block text-sm text-slate-600">
                  {t('sourcing.links.revokeReason')}
                  <input className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5" value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} />
                </label>
              )}
            </div>
          )}

          {tab === 'comparison' && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-3">
              <SourcingEvaluation
                detail={detail}
                evaluation={comparison}
                currentUser={currentUser}
                formatTime={formatAmsterdam}
                onError={setError}
                onReload={async () => {
                  setDetail(await api.getSourcingEvent(detail.id));
                  setComparison(await api.getSourcingComparison(detail.id));
                }}
              />
              <ul className="divide-y divide-slate-100">
                {(comparison?.invitations || []).map((row) => (
                  <li key={row.id} className="py-2">
                    <span className="font-medium">{row.supplier_name}</span>
                    <span className="text-slate-500"> · {t(`sourcing.portalStatus.${row.portal_status}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'award' && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
              <SourcingAward
                detail={detail}
                evaluation={comparison}
                currentUser={currentUser}
                onError={setError}
                onReload={async () => {
                  setDetail(await api.getSourcingEvent(detail.id));
                  setComparison(await api.getSourcingComparison(detail.id));
                }}
              />
            </div>
          )}

          {tab === 'qa' && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-3">
              {questions.length === 0 && <p className="text-slate-500">{t('sourcing.qa.empty')}</p>}
              {questions.map((row) => (
                <article key={row.id} className="border-t border-slate-100 pt-2">
                  <p className="font-medium">{row.supplier_code}: {row.question}</p>
                  {row.answer ? <p className="text-slate-600">{row.answer}</p> : ownerCanManage && (
                    <div className="mt-2 flex flex-wrap gap-2 items-end">
                      <input className="flex-1 rounded border border-slate-200 px-2 py-1.5" value={answerText} onChange={(event) => setAnswerText(event.target.value)} placeholder={t('sourcing.qa.answer')} />
                      <select className="rounded border border-slate-200 px-2 py-1.5" value={answerVisibility} onChange={(event) => setAnswerVisibility(event.target.value)}>
                        <option value="private">{t('sourcing.qa.private')}</option>
                        <option value="all">{t('sourcing.qa.all')}</option>
                      </select>
                      <button type="button" className="px-3 py-1.5 bg-slate-900 text-white rounded-lg" onClick={() => answerQuestion(row.id)}>{t('sourcing.qa.send')}</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}

          {tab === 'files' && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-sm text-slate-500">{t('sourcing.files.hint')}</p>
              {ownerCanEdit && (
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    uploadFile(file);
                  }}
                />
              )}
              <ul className="divide-y divide-slate-100">
                {detail.files.map((file) => (
                  <li key={file.id} className="py-2 flex flex-wrap items-center gap-3 text-sm">
                    <span>{file.filename}</span>
                    <span className="text-slate-500">{file.size_bytes} B</span>
                    <a
                      className="text-indigo-700 font-semibold"
                      href={api.sourcingFileUrl(detail.id, file.id)}
                    >
                      {t('sourcing.files.download')}
                    </a>
                    {ownerCanEdit && (
                      <button type="button" className="text-rose-700 text-xs" onClick={() => removeFile(file.id)}>
                        {t('sourcing.files.remove')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'history' && (
            <ul className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
              {detail.history.length === 0 && (
                <li className="px-4 py-3 text-sm text-slate-500">{t('sourcing.history.empty')}</li>
              )}
              {detail.history.map((row) => (
                <li key={row.id} className="px-4 py-3 text-sm">
                  <span className="font-medium">{row.action}</span>
                  <span className="text-slate-500"> · {row.actor_name} · {formatAmsterdam(row.created_at)}</span>
                  {row.details && <p className="text-slate-600 mt-1">{row.details}</p>}
                </li>
              ))}
            </ul>
          )}

          {canCancel && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap gap-2 items-end">
              {detail.status === 'evaluated' && <p className="w-full text-xs text-amber-700">{t('sourcing.cancelWithdrawsAward')}</p>}
              <label className="text-sm text-slate-600 flex-1">
                {t('sourcing.cancelReason')}
                <input
                  className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5"
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={saving}
                onClick={cancelEvent}
                className="px-3 py-2 bg-rose-700 text-white rounded-lg text-sm font-semibold"
              >
                {t('sourcing.confirmCancel')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
