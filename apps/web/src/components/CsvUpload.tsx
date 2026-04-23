import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ImportSummary, Platform } from '@consolidate/shared';

export function CsvUpload() {
  const [platform, setPlatform] = useState<Platform>('DIME');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [isOver, setIsOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (file: File) => api.importTradesCsv(file, platform),
    onSuccess: (data) => {
      setSummary(data);
      qc.invalidateQueries({ queryKey: ['portfolio'] });
      qc.invalidateQueries({ queryKey: ['trades'] });
    },
  });

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) mutation.mutate(file);
  };

  return (
    <div style={{ padding: '20px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Import trade CSV</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Drag in the export from DIME or Binance</div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 6 }}>
          {(['DIME', 'Binance'] as Platform[]).map((p) => (
            <button
              key={p}
              className="pill"
              data-active={platform === p}
              onClick={() => setPlatform(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsOver(true);
        }}
        onDragLeave={() => setIsOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          padding: 28,
          background: isOver ? 'var(--surface-2)' : 'var(--surface)',
          border: `1px dashed ${isOver ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 10,
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 12,
          cursor: 'pointer',
          transition: 'background .12s, border-color .12s',
        }}
      >
        ⇡ Drop {platform} trade CSV here, or click to choose
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {mutation.isPending && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Uploading…</div>
      )}
      {mutation.isError && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)' }}>
          Error: {(mutation.error as Error).message}
        </div>
      )}
      {summary && (
        <div style={{ marginTop: 14, padding: 12, background: 'var(--surface-2)', borderRadius: 8, fontSize: 12, fontFamily: 'var(--mono)' }}>
          <div style={{ color: 'var(--text)', marginBottom: 4 }}>
            {summary.platform}: {summary.imported} imported · {summary.skipped} skipped · {summary.errors.length} errors
          </div>
          {summary.errors.slice(0, 5).map((e, i) => (
            <div key={i} style={{ color: 'var(--down)' }}>
              row {e.row}: {e.error}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
