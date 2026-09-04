import React, { useState, useEffect } from 'react';
import { 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Clock, 
  DollarSign, 
  Building2, 
  User, 
  FileText,
  Check,
  X
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

export default function ApprovalsView({ currentUser, onNavigate, onDataChanged }) {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeDecisionModal, setActiveDecisionModal] = useState(null);
  const [decisionType, setDecisionType] = useState('approved');
  const [decisionComments, setDecisionComments] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadApprovals = async () => {
    if (!currentUser?.id) {
      setApprovals([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Personal queue only: waiting steps never appear (API defaults to pending).
      const list = await api.getApprovals(currentUser.id);
      setApprovals(list);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApprovals();
  }, [currentUser]);

  const handleOpenDecision = (item, type) => {
    setActiveDecisionModal(item);
    setDecisionType(type);
    setDecisionComments(type === 'approved' ? 'Approved. Aligns with departmental budget & priorities.' : '');
  };

  const handleExecuteDecision = async () => {
    if (!activeDecisionModal) return;
    if (decisionType === 'rejected' && !decisionComments.trim()) {
      alert('Please provide a reason when rejecting a requisition.');
      return;
    }

    setProcessing(true);
    try {
      await api.decideApproval(activeDecisionModal.approval_id, {
        decision: decisionType,
        comments: decisionComments,
        approver_id: currentUser?.id,
        approver_name: currentUser?.name || 'Authorized Approver'
      });
      setActiveDecisionModal(null);
      setDecisionComments('');
      await loadApprovals();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Approvals Inbox</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Review purchasing requisitions pending authorization. Verify business justification and remaining budget.
            Budget is committed only on the <strong>final</strong> approval step.
          </p>
        </div>

        <div className="flex items-center space-x-2 text-xs">
          <span className="text-slate-500">Active Approver:</span>
          <span className="font-bold text-slate-900">{currentUser?.name}</span>
          <span className="text-slate-400">•</span>
          <span className="text-emerald-700 font-semibold">
            Signing Limit: ${currentUser?.approval_limit ? formatMoney(currentUser.approval_limit) : 'Unlimited'}
          </span>
        </div>
      </div>

      {/* Approvals List */}
      <div className="space-y-4">
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-xs bg-white rounded-xl border border-slate-200">
            Loading pending approvals...
          </div>
        ) : approvals.length === 0 ? (
          <div className="p-12 text-center bg-white rounded-xl border border-slate-200">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2 opacity-80" />
            <h3 className="text-sm font-bold text-slate-900">Your Approval Queue is Empty!</h3>
            <p className="text-xs text-slate-500 mt-1">
              There are currently no requisitions waiting for your signature.
            </p>
          </div>
        ) : (
          approvals.map((item) => {
            const hasExceededBudget = item.available_budget !== null && item.total_amount > item.available_budget;
            const canAct = Number(currentUser?.id) === Number(item.approver_id);
            return (
              <div 
                key={item.approval_id} 
                className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-all"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  {/* Left Column: Requisition Meta */}
                  <div className="space-y-2 flex-1">
                    <div className="flex items-center space-x-3">
                      <span className="font-mono font-bold text-slate-900 text-sm">{item.pr_number}</span>
                      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                        item.priority === 'High' || item.priority === 'Urgent'
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-slate-100 text-slate-700'
                      }`}>
                        {item.priority} Priority
                      </span>
                      <span className="text-xs text-slate-400">Tier {item.step_order} Authorization</span>
                    </div>

                    <div className="text-xs text-slate-800">
                      <strong className="text-slate-900">{item.requester_name}</strong> requested on behalf of{' '}
                      <span className="font-semibold text-slate-900">{item.department_name}</span> ({item.department_code})
                    </div>

                    {/* Justification quote box */}
                    <div className="p-3 bg-slate-50 rounded-lg text-xs text-slate-700 border-l-2 border-emerald-500">
                      <span className="font-semibold text-slate-500 text-[10px] uppercase block mb-0.5">Business Justification</span>
                      "{item.justification}"
                    </div>

                    {/* Budget Impact Indicator */}
                    <div className="flex items-center space-x-4 text-[11px] text-slate-500 pt-1">
                      <span>Available Dept Budget: <strong className="text-slate-800">${formatMoney(item.available_budget)}</strong></span>
                      <span>Total Cost: <strong className="text-emerald-700 text-xs font-bold">${formatMoney(item.total_amount)}</strong></span>
                      {hasExceededBudget && (
                        <span className="text-rose-600 font-semibold flex items-center">
                          <AlertTriangle className="w-3.5 h-3.5 mr-1" />
                          Exceeds remaining budget — final approval will be blocked
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Decision Buttons — only the assigned persona can act */}
                  <div className="flex flex-col items-end space-y-2 self-end lg:self-center">
                    {canAct ? (
                      <div className="flex items-center space-x-3">
                        <button
                          onClick={() => handleOpenDecision(item, 'rejected')}
                          className="px-4 py-2 bg-white hover:bg-rose-50 text-rose-600 border border-rose-200 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>Reject</span>
                        </button>
                        <button
                          onClick={() => handleOpenDecision(item, 'approved')}
                          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm transition-colors"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Approve PR</span>
                        </button>
                      </div>
                    ) : (
                      <span className="text-[11px] text-slate-500">
                        Assigned to {item.assigned_approver_name || 'another approver'} — you cannot act on this step
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Decision Modal */}
      {activeDecisionModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center space-x-2 text-slate-900 font-bold text-base mb-1">
              {decisionType === 'approved' ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  <span>Approve Requisition {activeDecisionModal.pr_number}</span>
                </>
              ) : (
                <>
                  <XCircle className="w-5 h-5 text-rose-600" />
                  <span>Reject Requisition {activeDecisionModal.pr_number}</span>
                </>
              )}
            </div>
            <p className="text-xs text-slate-500 mb-4">
              {decisionType === 'approved'
                ? `Authorizing $${formatMoney(activeDecisionModal.total_amount)} from ${activeDecisionModal.department_name} budget.`
                : 'Please document why this procurement request cannot be approved.'}
            </p>

            <div className="space-y-3 text-xs">
              <label className="block text-slate-700 font-medium">
                {decisionType === 'approved' ? 'Approver Notes / Comments (Optional)' : 'Rejection Reason (Required)'}
              </label>
              <textarea
                rows="3"
                value={decisionComments}
                onChange={(e) => setDecisionComments(e.target.value)}
                placeholder={decisionType === 'approved' ? 'Add any notes for procurement or requester...' : 'Specify why this was rejected...'}
                className="w-full p-2.5 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div className="flex justify-end space-x-2 mt-5">
              <button
                type="button"
                onClick={() => setActiveDecisionModal(null)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteDecision}
                disabled={processing}
                className={`px-4 py-2 rounded-lg text-xs font-semibold text-white ${
                  decisionType === 'approved' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
                }`}
              >
                {processing ? 'Processing...' : `Confirm ${decisionType === 'approved' ? 'Approval' : 'Rejection'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
