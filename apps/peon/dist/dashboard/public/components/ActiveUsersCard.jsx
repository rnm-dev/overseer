(function () {
  const { Card, Badge } = window.ACA;

  // Purely presentational — `users` is fed by App's single app-lifetime
  // presence connection (GET /api/v1/presence/stream), not fetched here. A
  // second card-owned connection would duplicate that stream for no reason;
  // App already tracks who's on the whole dashboard, this just renders it.
  function ActiveUsersCard({ users }) {
    const list = users ?? [];
    return (
      <Card title="Active users">
        {list.length === 0 && <p className="text-sm text-slate-500">No one else is around right now.</p>}
        {list.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {list.map((username) => (
              <li key={username}>
                <Badge tone="green">{username}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  window.ACA.ActiveUsersCard = ActiveUsersCard;
})();
