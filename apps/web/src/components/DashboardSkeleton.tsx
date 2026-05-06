// Replaces the black "API error" / "Loading…" screens with a layout
// that mirrors the real dashboard. Keeps the user oriented (they see
// where data WILL appear) while either the network or auth resolves.

const SHIMMER = {
  background: 'linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 1.6s ease-in-out infinite',
  borderRadius: 6,
};

export function DashboardSkeleton() {
  return (
    <>
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 28px 120px' }}>
        {/* Hero row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <Block height={220} />
          <Block height={220} />
        </div>

        {/* Stats strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <Block height={88} />
          <Block height={88} />
          <Block height={88} />
          <Block height={88} />
        </div>

        {/* Mid row: donut + winloss */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <Block height={260} />
          <Block height={260} />
        </div>

        {/* Positions table */}
        <Block height={420} />
      </div>
    </>
  );
}

function Block({ height }: { height: number }) {
  return <div style={{ ...SHIMMER, height, width: '100%' }} />;
}
