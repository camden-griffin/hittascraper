import { useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import { api, type Lead } from '../lib/api';

const col = createColumnHelper<Lead>();
const PAGE_SIZE = 100;

function formatDebt(v: string | null | undefined): string {
  if (!v || v.trim() === '') return '';
  const cleaned = v.trim().replace(/^0+(\d)/, '$1');
  const n = Number(cleaned);
  if (isNaN(n) || n === 0) return '';
  return n.toLocaleString('sv-SE') + ' kr';
}

function formatRevenue(v: number | null | undefined): string {
  if (v == null) return '';
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace('.', ',') + ' Mkr';
  if (Math.abs(v) >= 1_000) return Math.round(v / 1_000).toLocaleString('sv-SE') + ' tkr';
  return v.toLocaleString('sv-SE') + ' kr';
}

export function LeadsTable({ logout }: { logout: () => void }) {
  const [rows, setRows] = useState<Lead[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [hideResolved, setHideResolved] = useState(false);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PAGE_SIZE });

  useEffect(() => {
    Promise.all([api.getLeads(), api.getBranches()])
      .then(([leads, b]) => { setRows(leads); setBranches(b); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { setPagination((p) => ({ ...p, pageIndex: 0 })); }, [globalFilter, columnFilters, sorting, hideResolved]);

  async function updateLead(org_nr: string, patch: Partial<Lead>) {
    setRows((prev) => prev.map((r) => (r.org_nr === org_nr ? { ...r, ...patch } : r)));
    try {
      const updated = await api.patchLead(org_nr, patch);
      setRows((prev) => prev.map((r) => (r.org_nr === org_nr ? updated : r)));
      if ('branch' in patch) api.getBranches().then(setBranches).catch(() => {});
    } catch (e: any) {
      setErr(e.message);
      api.getLeads().then(setRows).catch(() => {});
    }
  }

  const columns = useMemo(() => [
    col.accessor('resolved', {
      header: '',
      cell: (info) => (
        <input
          type="checkbox"
          checked={!!info.getValue()}
          onChange={(e) => updateLead(info.row.original.org_nr, { resolved: e.target.checked ? 1 : 0 })}
          className="h-4 w-4 mt-0.5"
        />
      ),
      enableSorting: false,
      size: 32,
    }),
    col.accessor('icp_score', {
      header: 'ICP',
      cell: (i) => {
        const v = i.getValue();
        if (v == null) return '';
        const color = v >= 10 ? 'bg-green-100 text-green-800' : v >= 7 ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600';
        return <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${color}`}>{v}</span>;
      },
      size: 48,
    }),
    col.accessor('name', {
      header: 'Name',
      cell: (i) => <span className="font-medium">{i.getValue() ?? ''}</span>,
    }),
    col.accessor('email', {
      header: 'Email',
      cell: (i) => {
        const v = i.getValue();
        return v ? <a className="text-blue-600 hover:underline text-xs" href={`mailto:${v}`}>{v}</a> : '';
      },
    }),
    col.accessor('phone', {
      header: 'Phone',
      cell: (i) => {
        const v = i.getValue();
        return v ? <a className="text-blue-600 hover:underline text-xs whitespace-nowrap" href={`tel:${v}`}>{v}</a> : '';
      },
    }),
    col.accessor('branch', {
      header: 'Branch',
      cell: (info) => (
        <div className="min-w-[8rem] max-w-[14rem]">
          <EditableCell
            value={info.getValue() ?? ''}
            onSave={(v) => updateLead(info.row.original.org_nr, { branch: v || null })}
            multiline
          />
        </div>
      ),
      filterFn: (row, _id, value) => !value || row.getValue('branch') === value,
    }),
    col.accessor('employees', {
      header: 'Employees',
      cell: (i) => i.getValue() ?? '',
      size: 50,
    }),
    col.accessor('omsattning_sek', {
      header: 'Revenue',
      cell: (i) => <span className="whitespace-nowrap">{formatRevenue(i.getValue())}</span>,
    }),
    col.accessor('keyword_line_1', {
      header: 'Debt Type',
      cell: (i) => {
        const v = i.getValue();
        if (!v) return '';
        // Shorten common Swedish debt labels
        const short = v
          .replace(/Övriga skulder till kreditinstitut/i, 'Övr. skulder kreditinst.')
          .replace(/Skulder till kreditinstitut/i, 'Skulder kreditinst.')
          .replace(/Checkräkningskredit/i, 'Checkräkning')
          .replace(/hos banker och andra kreditinstitut.*$/i, 'Kreditinstitut');
        const display = short.length > 30 ? short.slice(0, 28) + '…' : short;
        return <span className="text-xs text-slate-600" title={v}>{display}</span>;
      },
    }),
    col.accessor('recent_year_value', {
      header: 'Debt (Recent)',
      cell: (i) => <span className="whitespace-nowrap tabular-nums">{formatDebt(i.getValue())}</span>,
    }),
    col.accessor('previous_year_value', {
      header: 'Debt (Prev)',
      cell: (i) => <span className="whitespace-nowrap tabular-nums text-slate-500">{formatDebt(i.getValue())}</span>,
    }),
    col.accessor('notes', {
      header: 'Notes',
      cell: (info) => (
        <EditableCell
          value={info.getValue() ?? ''}
          onSave={(v) => updateLead(info.row.original.org_nr, { notes: v || null })}
        />
      ),
    }),
  ], []);

  const filteredRows = useMemo(
    () => (hideResolved ? rows.filter((r) => !r.resolved) : rows),
    [rows, hideResolved],
  );

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting, columnFilters, globalFilter, pagination },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: 'includesString',
    autoResetPageIndex: false,
  });

  const branchFilterValue = (table.getColumn('branch')?.getFilterValue() as string) ?? '';
  const { pageIndex } = table.getState().pagination;
  const pageCount = table.getPageCount();
  const filteredCount = table.getFilteredRowModel().rows.length;

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* Toolbar */}
      <div className="shrink-0 flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search name, org nr, email…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="rounded border border-slate-300 px-3 py-1.5 w-64 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={branchFilterValue}
          onChange={(e) => table.getColumn('branch')?.setFilterValue(e.target.value || undefined)}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm max-w-xs"
        >
          <option value="">All branches</option>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={hideResolved} onChange={(e) => setHideResolved(e.target.checked)} />
          Hide resolved
        </label>
        <span className="text-sm text-slate-500 ml-auto">
          {filteredCount.toLocaleString()} of {rows.length.toLocaleString()} rows
          {rows.length > 0 && ` · ${rows.filter((r) => r.resolved).length} resolved`}
        </span>
        <button onClick={logout} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">
          Sign out
        </button>
      </div>

      {err && <p className="shrink-0 text-sm text-red-600">{err}</p>}

      {/* Table */}
      <div className="flex-1 overflow-auto rounded border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const canSort = h.column.getCanSort();
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      className={`text-left px-2 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap ${canSort ? 'cursor-pointer select-none hover:text-slate-900' : ''}`}
                      onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {sorted === 'asc' && ' ▲'}
                      {sorted === 'desc' && ' ▼'}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="p-4 text-slate-500" colSpan={columns.length}>Loading…</td></tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr><td className="p-4 text-slate-500" colSpan={columns.length}>No leads found.</td></tr>
            ) : (
              table.getRowModel().rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${r.original.resolved ? 'opacity-50' : ''}`}
                >
                  {r.getVisibleCells().map((c) => (
                    <td key={c.id} className="px-2 py-1.5 align-top">
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="shrink-0 flex items-center justify-between gap-2 text-sm text-slate-600">
          <span>Page {pageIndex + 1} of {pageCount}</span>
          <div className="flex gap-1">
            <PagBtn onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>«</PagBtn>
            <PagBtn onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>‹</PagBtn>
            <PagBtn onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>›</PagBtn>
            <PagBtn onClick={() => table.setPageIndex(pageCount - 1)} disabled={!table.getCanNextPage()}>»</PagBtn>
          </div>
        </div>
      )}
    </div>
  );
}

function PagBtn({ onClick, disabled, children }: { onClick: () => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2 py-1 rounded border border-slate-300 disabled:opacity-40 hover:bg-slate-100 text-base leading-none"
    >
      {children}
    </button>
  );
}

function EditableCell({ value, onSave, multiline }: { value: string; onSave: (v: string) => void; multiline?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);

  const commonClass = "w-full bg-transparent border border-transparent rounded px-1 py-0.5 text-sm hover:border-slate-200 focus:border-blue-500 focus:outline-none focus:bg-white resize-none break-words";

  if (multiline) {
    return (
      <textarea
        value={v}
        rows={v.split('\n').length || 1}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v !== value) onSave(v); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setV(value); (e.target as HTMLTextAreaElement).blur(); }
        }}
        className={commonClass + " leading-snug overflow-hidden"}
        style={{ height: 'auto', minHeight: '1.6rem' }}
      />
    );
  }

  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== value) onSave(v); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur(); }
      }}
      className={commonClass}
    />
  );
}
