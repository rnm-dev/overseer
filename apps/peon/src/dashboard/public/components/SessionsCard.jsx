(function () {
  const { SessionsList, SessionDetail, NewSessionScreen } = window.ACA;

  function SessionsCard({ selectedId, subPath, onSelect, base, peonName }) {
    if (selectedId === "new") {
      const parts = subPath?.split("/") ?? [];
      const initialProjectKey = parts[1];
      return (
        <NewSessionScreen
          initialProjectKey={initialProjectKey}
          onBack={() => onSelect(null)}
          onStarted={(id) => onSelect(id)}
          base={base}
        />
      );
    }
    if (selectedId) {
      return <SessionDetail id={selectedId} onBack={() => onSelect(null)} base={base} peonName={peonName} />;
    }
    return <SessionsList onSelect={onSelect} base={base} />;
  }


  window.ACA.SessionsCard = SessionsCard;
})();
