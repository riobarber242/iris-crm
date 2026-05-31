export default function HomePage() {
  return (
    <main className="min-h-screen bg-iris-background text-white px-6 py-8">
      <section className="mx-auto max-w-6xl">
        <div className="rounded-[32px] border border-white/10 bg-iris-card/90 p-10 shadow-iris backdrop-blur-xl">
          <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-iris-pink">Iris CRM</p>
              <h1 className="mt-4 text-4xl font-semibold text-white">Panel de gestión premium</h1>
              <p className="mt-4 max-w-2xl text-lg text-iris-text-muted">
                Administrá contactos, conversaciones, comprobantes y campañas con estilo fintech oscuro.
              </p>
            </div>
            <div className="rounded-3xl bg-gradient-to-br from-iris-purple via-[#5e2bff] to-iris-green p-1 shadow-iris">
              <div className="rounded-3xl bg-iris-background px-8 py-6 text-center">
                <p className="text-sm uppercase tracking-[0.3em] text-iris-gold">Cuenta</p>
                <p className="mt-4 text-5xl font-semibold text-white">Iris</p>
                <p className="mt-2 text-iris-text-muted">Cajera virtual en línea</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
