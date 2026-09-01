# Project administration

Workspace owners retain unrestricted access to every Peon and project. A
regular workspace member may create a project on a workspace Peon; the creator
is automatically recorded as that project's administrator and gains the Peon
access required to open it.

A project administrator has access to that project and its sessions, and may
add or remove regular workspace members from that project's member list. The
grant also supplies the Peon access required to open the project. It does not
make the administrator a workspace owner, reveal other projects, or permit
workspace-wide member/Peon administration.

The administrator role is a separate durable grant keyed by Peon and canonical
`projectId`, rather than a workspace role or mutable project key. It is removed
when its workspace member is removed or the project is deleted. Project owners
are not editable: they are always unrestricted.

In the web UI, project administrators see the **Members** tab; workspace owners
also see the project **Settings** tab. The project member list labels a creator
as a project administrator and prevents removing their own administrative
access through the ordinary participant toggle.
