export default function NoAccess() {
  return (
    <main className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold">No organization yet</h1>
      <p className="mt-2 text-sm muted">Your account isn't a member of any business. Ask the owner to invite you.</p>
      <form action="/auth/logout" method="post" className="mt-4"><button className="text-sm underline">Sign out</button></form>
    </main>
  );
}
