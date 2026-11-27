import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChefHat,
  Clock,
  Copy,
  Printer,
  RotateCcw,
  Smartphone,
  Trash2,
  UtensilsCrossed,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import type { KotKitchenStatus, KotTicket, StoreConfig } from '../types';
import { formatDailyToken, formatDateTime } from '../utils/posHelpers';

interface KitchenKotQueueViewProps {
  store: StoreConfig;
  tickets: KotTicket[];
  soundEnabled: boolean;
  onToggleSound: () => void;
  autoPrintEnabled: boolean;
  onToggleAutoPrint: () => void;
  onPrintTicket: (ticket: KotTicket, autoPrint?: boolean) => void;
  onMarkPrinted: (ticketId: string) => Promise<void>;
  onUpdateKitchenStatus: (ticketId: string, nextStatus: KotKitchenStatus) => Promise<void>;
  onClearPrinted: () => Promise<void>;
  onTestBell: () => Promise<boolean> | void;
}

const KIND_LABELS: Record<KotTicket['ticketKind'], { label: string; className: string }> = {
  new: {
    label: 'NEW ORDER',
    className:
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  },
  addon: {
    label: 'ADD-ON KOT',
    className:
      'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  },
  revised: {
    label: 'REVISED KOT',
    className:
      'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300 border-amber-300 dark:border-amber-800',
  },
  reprint: {
    label: 'REPRINT REQUEST',
    className:
      'bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  },
};

function getEffectiveKitchenStatus(ticket: KotTicket): KotKitchenStatus {
  if (ticket.kitchenStatus === 'ready' || ticket.kitchenStatus === 'served') {
    return ticket.kitchenStatus;
  }
  return 'preparing';
}

function formatElapsedMinutes(createdAt: KotTicket['createdAt'], nowMs: number): {
  label: string;
  urgent: 'normal' | 'warm' | 'hot';
} {
  const createdMs = createdAt?.toMillis?.();
  if (!createdMs) return { label: 'Just now', urgent: 'normal' };
  const mins = Math.max(0, Math.floor((nowMs - createdMs) / 60000));
  if (mins < 1) return { label: 'Just now', urgent: 'normal' };
  if (mins >= 20) return { label: `${mins}m ago`, urgent: 'hot' };
  if (mins >= 10) return { label: `${mins}m ago`, urgent: 'warm' };
  return { label: `${mins}m ago`, urgent: 'normal' };
}

export const KitchenKotQueueView: React.FC<KitchenKotQueueViewProps> = ({
  store,
  tickets,
  soundEnabled,
  onToggleSound,
  autoPrintEnabled,
  onToggleAutoPrint,
  onPrintTicket,
  onMarkPrinted,
  onUpdateKitchenStatus,
  onClearPrinted,
  onTestBell,
}) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [copiedStationUrl, setCopiedStationUrl] = useState(false);
  const [bellStatus, setBellStatus] = useState<'idle' | 'played' | 'blocked'>('idle');
  const [statusFilter, setStatusFilter] = useState<'all' | 'preparing' | 'ready' | 'pending_print'>('all');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const stationUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/?station=kot';
    return `${window.location.origin}/?station=kot`;
  }, []);

  const activeKitchenTickets = useMemo(() => {
    return tickets
      .filter((t) => {
        const kStatus = getEffectiveKitchenStatus(t);
        if (t.ticketKind === 'reprint') {
          return t.status === 'pending';
        }
        return kStatus !== 'served' || t.status === 'pending';
      })
      .sort((a, b) => {
        const aReady = getEffectiveKitchenStatus(a) === 'ready' ? 0 : 1;
        const bReady = getEffectiveKitchenStatus(b) === 'ready' ? 0 : 1;
        if (aReady !== bReady) return aReady - bReady;
        return (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0);
      });
  }, [tickets]);

  const pendingPrintCount = useMemo(
    () => tickets.filter((t) => t.status === 'pending').length,
    [tickets]
  );

  const preparingCount = useMemo(
    () =>
      activeKitchenTickets.filter(
        (t) => t.ticketKind !== 'reprint' && getEffectiveKitchenStatus(t) === 'preparing'
      ).length,
    [activeKitchenTickets]
  );

  const readyCount = useMemo(
    () =>
      activeKitchenTickets.filter(
        (t) => t.ticketKind !== 'reprint' && getEffectiveKitchenStatus(t) === 'ready'
      ).length,
    [activeKitchenTickets]
  );

  const servedHistoryTickets = useMemo(() => {
    return tickets
      .filter((t) => {
        const kStatus = getEffectiveKitchenStatus(t);
        if (t.ticketKind === 'reprint') return t.status === 'printed';
        return kStatus === 'served' && t.status === 'printed';
      })
      .sort((a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0));
  }, [tickets]);

  const filteredActiveTickets = useMemo(() => {
    if (statusFilter === 'all') return activeKitchenTickets;
    if (statusFilter === 'pending_print') {
      return activeKitchenTickets.filter((t) => t.status === 'pending');
    }
    return activeKitchenTickets.filter(
      (t) => t.ticketKind !== 'reprint' && getEffectiveKitchenStatus(t) === statusFilter
    );
  }, [activeKitchenTickets, statusFilter]);

  const handleCopyStationLink = async () => {
    try {
      await navigator.clipboard.writeText(stationUrl);
      setCopiedStationUrl(true);
      window.setTimeout(() => setCopiedStationUrl(false), 2200);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleMarkDone = async (ticketId: string) => {
    setBusyId(ticketId);
    try {
      await onMarkPrinted(ticketId);
    } finally {
      setBusyId(null);
    }
  };

  const handleKitchenAction = async (ticketId: string, nextStatus: KotKitchenStatus) => {
    setBusyId(ticketId);
    setActionError(null);
    try {
      await onUpdateKitchenStatus(ticketId, nextStatus);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err ?? '');
      if (rawMsg.toLowerCase().includes('permission')) {
        setActionError(
          'Firestore security rules update required: please publish the latest firestore.rules in Firebase Console → Firestore Database → Rules so Mark Ready / Mark Served updates are allowed.'
        );
      } else {
        setActionError(rawMsg || 'Unable to update kitchen order status.');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleClear = async () => {
    if (servedHistoryTickets.length === 0) return;
    setClearing(true);
    try {
      await onClearPrinted();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-5">
      {actionError && (
        <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 flex items-start justify-between gap-3 text-xs text-red-800 dark:text-red-200">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <span className="leading-relaxed">{actionError}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="rounded-lg p-1 text-red-600 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 cursor-pointer shrink-0"
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Live Kitchen Status & Print KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div
          className={`rounded-xl border p-4 ${
            preparingCount > 0
              ? 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
          }`}
        >
          <div className="text-xs text-slate-600 dark:text-slate-400">Preparing in Kitchen</div>
          <div
            className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
              preparingCount > 0
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {preparingCount}
          </div>
        </div>

        <div
          className={`rounded-xl border p-4 ${
            readyCount > 0
              ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-950/35'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
          }`}
        >
          <div className="text-xs text-slate-600 dark:text-slate-400">Ready to Serve</div>
          <div
            className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
              readyCount > 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {readyCount}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Waiting Thermal Print</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {pendingPrintCount}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Served History</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-700 dark:text-slate-300">
            {servedHistoryTickets.length}
          </div>
        </div>
      </div>

      {/* Counter / Kitchen Station & Auto-Print Controls */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ChefHat className="w-4 h-4 brand-text shrink-0" />
              <h2 className="text-sm font-bold font-display text-slate-900 dark:text-slate-100">
                Live Kitchen Display &amp; KOT Station — {store.name}
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed max-w-2xl">
              Track live cooking progress (<strong>Preparing → Ready → Served</strong>) and auto-print thermal KOTs. Marking an order{' '}
              <strong>Ready</strong> chimes &amp; alerts waiters on mobile immediately.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onToggleSound}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold cursor-pointer transition-colors ${
                soundEnabled
                  ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
              }`}
            >
              {soundEnabled ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
              <span>Sound Alert: {soundEnabled ? 'ON' : 'OFF'}</span>
            </button>

            <button
              type="button"
              onClick={async () => {
                const ok = await onTestBell();
                setBellStatus(ok === false ? 'blocked' : 'played');
                window.setTimeout(() => setBellStatus('idle'), 2200);
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium cursor-pointer transition-colors ${
                bellStatus === 'played'
                  ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                  : bellStatus === 'blocked'
                    ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
              title="Play test bell and enable audio in this browser tab"
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>
                {bellStatus === 'played'
                  ? 'Bell Played!'
                  : bellStatus === 'blocked'
                    ? 'Browser Muted'
                    : 'Test Bell'}
              </span>
            </button>

            <button
              type="button"
              onClick={onToggleAutoPrint}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold cursor-pointer transition-colors ${
                autoPrintEnabled
                  ? 'brand-bg text-white shadow-xs'
                  : 'border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Auto-Print KOT: {autoPrintEnabled ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        </div>

        {/* Dual-Printer Station Link Bar */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="text-xs text-slate-600 dark:text-slate-400">
            <strong className="text-slate-800 dark:text-slate-200">Kitchen Screen / 2-Printer Tip:</strong>{' '}
            Open this station link on your Kitchen tablet or 2nd Chrome window so cooks can tap <strong>Mark Ready</strong> and auto-print KOTs.
          </div>
          <button
            type="button"
            onClick={() => void handleCopyStationLink()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedStationUrl ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-emerald-700 dark:text-emerald-400">Station Link Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Kitchen Link</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Active Kitchen Orders Board */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold font-display text-slate-900 dark:text-slate-100">
              Active Kitchen Orders ({activeKitchenTickets.length})
            </h3>
            {autoPrintEnabled && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                <Zap className="w-3.5 h-3.5" />
                <span>Auto-Print Active</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
            {(
              [
                { id: 'all', label: `All (${activeKitchenTickets.length})` },
                { id: 'preparing', label: `Preparing (${preparingCount})` },
                { id: 'ready', label: `Ready (${readyCount})` },
                { id: 'pending_print', label: `Print Queue (${pendingPrintCount})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                  statusFilter === tab.id
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredActiveTickets.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-2">
            <UtensilsCrossed className="w-7 h-7 mx-auto text-slate-300 dark:text-slate-600" />
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {activeKitchenTickets.length === 0
                ? 'No active orders in kitchen'
                : 'No orders match this filter'}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              New dine-in orders, add-ons, and revisions from Waiter Mobile or Counter POS appear here live until served.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredActiveTickets.map((ticket) => {
              const badge = KIND_LABELS[ticket.ticketKind];
              const kitchenStatus = getEffectiveKitchenStatus(ticket);
              const isReady = kitchenStatus === 'ready';
              const isReprint = ticket.ticketKind === 'reprint';
              const elapsed = formatElapsedMinutes(ticket.createdAt, nowMs);

              return (
                <div
                  key={ticket.id}
                  className={`rounded-xl border-2 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-3 shadow-xs ${
                    isReady
                      ? 'border-emerald-400 dark:border-emerald-600 ring-1 ring-emerald-500/20'
                      : 'border-amber-300 dark:border-amber-700'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                            {ticket.tableNumber
                              ? `Table ${ticket.tableNumber}`
                              : ticket.orderType === 'delivery'
                              ? 'Delivery'
                              : ticket.orderType === 'takeaway'
                              ? 'Takeaway'
                              : 'Counter Order'}
                          </span>
                          {formatDailyToken(ticket.tokenNumber) && (
                            <span className="text-[11px] font-bold font-mono px-2 py-0.5 rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100">
                              Token {formatDailyToken(ticket.tokenNumber)}
                            </span>
                          )}
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded border ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                          {!isReprint && (
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                                isReady
                                  ? 'bg-emerald-600 text-white border-emerald-600'
                                  : 'bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-950/60 dark:text-orange-300 dark:border-orange-800'
                              }`}
                            >
                              {isReady ? 'READY TO SERVE' : 'PREPARING'}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="font-mono">{ticket.ticketNumber}</span>
                          <span
                            className={`inline-flex items-center gap-1 font-medium ${
                              elapsed.urgent === 'hot'
                                ? 'text-red-600 dark:text-red-400 font-bold'
                                : elapsed.urgent === 'warm'
                                  ? 'text-amber-700 dark:text-amber-400 font-semibold'
                                  : ''
                            }`}
                          >
                            <Clock className="w-3 h-3" />
                            <span>{elapsed.label}</span>
                          </span>
                          {ticket.status === 'pending' && (
                            <span className="text-amber-700 dark:text-amber-400 font-semibold">
                              · Unprinted
                            </span>
                          )}
                        </div>
                      </div>

                      {ticket.source === 'waiter_mobile' && (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 dark:text-teal-400 shrink-0"
                          title="Sent from Waiter Mobile App"
                        >
                          <Smartphone className="w-3.5 h-3.5" />
                          <span>Mobile</span>
                        </span>
                      )}
                    </div>

                    {(ticket.employeeName || ticket.customerName) && (
                      <div className="rounded-lg bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs flex flex-wrap items-center justify-between gap-2 text-slate-700 dark:text-slate-300">
                        {ticket.employeeName && (
                          <span>
                            Waiter: <strong>{ticket.employeeName}</strong>
                          </span>
                        )}
                        {ticket.customerName && (
                          <span className="truncate">Guest: {ticket.customerName}</span>
                        )}
                      </div>
                    )}

                    {ticket.changeNotes && ticket.changeNotes.length > 0 && (
                      <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 text-xs font-mono space-y-0.5 text-amber-950 dark:text-amber-200">
                        <div className="text-[10px] font-sans font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                          Changes Made:
                        </div>
                        {ticket.changeNotes.map((note, idx) => (
                          <div key={idx}>{note}</div>
                        ))}
                      </div>
                    )}

                    <div className="divide-y divide-slate-100 dark:divide-slate-800 border-t border-slate-100 dark:border-slate-800 pt-1">
                      {ticket.items.map((item, idx) => (
                        <div
                          key={`${item.productId}-${idx}`}
                          className="py-1.5 space-y-0.5 text-xs"
                        >
                          <div className="font-semibold text-slate-900 dark:text-slate-100">
                            <span className="font-mono font-bold brand-text mr-2">
                              {item.quantity}x
                            </span>
                            {item.name}
                          </div>
                          {item.note && (
                            <div className="pl-6 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                              ↳ {item.note}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Kitchen Status & Print Action Controls */}
                  <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                    {!isReprint && (
                      <div className="flex items-center gap-2">
                        {kitchenStatus === 'preparing' ? (
                          <button
                            type="button"
                            disabled={busyId === ticket.id}
                            onClick={() => void handleKitchenAction(ticket.id, 'ready')}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3.5 py-2.5 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer"
                          >
                            <Bell className="w-3.5 h-3.5" />
                            <span>
                              {busyId === ticket.id ? 'Updating...' : 'Mark Ready (Notify Waiter)'}
                            </span>
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busyId === ticket.id}
                              onClick={() => void handleKitchenAction(ticket.id, 'served')}
                              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2.5 text-xs font-semibold text-white dark:text-slate-900 disabled:opacity-50 cursor-pointer"
                            >
                              <CheckCheck className="w-3.5 h-3.5" />
                              <span>{busyId === ticket.id ? 'Updating...' : 'Mark Served'}</span>
                            </button>
                            <button
                              type="button"
                              disabled={busyId === ticket.id}
                              onClick={() => void handleKitchenAction(ticket.id, 'preparing')}
                              className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-2.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                              title="Move back to Preparing"
                            >
                              Undo
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onPrintTicket(ticket, false)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <Printer className="w-3.5 h-3.5" />
                        <span>{ticket.status === 'pending' ? 'Print KOT' : 'Reprint KOT'}</span>
                      </button>
                      {ticket.status === 'pending' && (
                        <button
                          type="button"
                          disabled={busyId === ticket.id}
                          onClick={() => void handleMarkDone(ticket.id)}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                          title="Mark printed without opening print dialog"
                        >
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          <span>{busyId === ticket.id ? '...' : 'Printed'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Served & Printed KOT History */}
      {servedHistoryTickets.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-bold font-display text-slate-900 dark:text-slate-100">
              Served &amp; Printed KOT History ({servedHistoryTickets.length})
            </h3>
            <button
              type="button"
              disabled={clearing}
              onClick={() => void handleClear()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{clearing ? 'Clearing...' : 'Clear History'}</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/40 text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-4 font-medium">Table / Ticket</th>
                  <th className="py-2.5 px-4 font-medium">Items</th>
                  <th className="py-2.5 px-4 font-medium">Waiter</th>
                  <th className="py-2.5 px-4 font-medium">Time</th>
                  <th className="py-2.5 px-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {servedHistoryTickets.slice(0, 30).map((ticket) => (
                  <tr
                    key={ticket.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {ticket.tableNumber
                          ? `Table ${ticket.tableNumber}`
                          : ticket.orderType === 'delivery'
                          ? 'Delivery'
                          : ticket.orderType === 'takeaway'
                          ? 'Takeaway'
                          : 'Counter'}
                        {formatDailyToken(ticket.tokenNumber)
                          ? ` · Token ${formatDailyToken(ticket.tokenNumber)}`
                          : ''}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400">
                        {ticket.ticketNumber} · {KIND_LABELS[ticket.ticketKind].label}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300 max-w-xs truncate">
                      {ticket.items
                        .map((i) => `${i.quantity}x ${i.name}${i.note ? ` [${i.note}]` : ''}`)
                        .join(', ')}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 dark:text-slate-400">
                      {ticket.employeeName || '—'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {formatDateTime(ticket.createdAt)}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => onPrintTicket(ticket, false)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Reprint</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
