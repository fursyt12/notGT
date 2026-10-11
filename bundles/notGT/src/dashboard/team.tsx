/**
 * notGT — Team dashboard panel (fullbleed): who works on the show.
 *
 * Left: the groups — VJ, Streamer 1, … — each with the outs it works with and
 * the WebSocket keys that reach those outs only. Right: the users and the
 * groups they are in, and the OBS link of every out.
 *
 * Only an administrator sees any of it; everyone else is told whose job it is.
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";

import {
	DEFAULT_ADMIN,
	MIN_PASSWORD,
	TEAM_BASE,
	type TeamGroupInfo,
	type TeamState,
	type TeamUserInfo,
} from "../shared/team";
import type { Out } from "../shared/types";
import { t, useLang } from "./i18n";
import { absoluteOutUrl, useAllOuts, useMe, useTeamRevision } from "./shared";
import { CopyButton, Icon, IconButton, LangSwitch, Menu, NameInput, ThemeSwitch } from "./ui";

/** Sends a change to the server; rejects with the server's own words. */
async function request(method: string, path: string, body?: unknown): Promise<void> {
	const response = await fetch(`${TEAM_BASE}${path}`, {
		method,
		headers: { "content-type": "application/json", accept: "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (response.ok) return;
	const answer = (await response.json().catch(() => null)) as { message?: string } | null;
	throw new Error(answer?.message ?? `HTTP ${response.status}`);
}

type Run = (change: Promise<void>) => void;

/** Asks for a new password for a user and sets it. */
function changePassword(user: TeamUserInfo, run: Run): void {
	const password = window.prompt(t("A new password for {name}:", { name: user.username }));
	if (password === null) return;
	if (password.length < MIN_PASSWORD) {
		window.alert(t("A password needs at least {n} characters.", { n: MIN_PASSWORD }));
		return;
	}
	run(request("PATCH", `/users/${user.id}`, { password }));
}

/** One box in a row of boxes: "this out is in the group", "this user is in the group". */
function Pick({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
	return (
		<label className="check tm-pick">
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			<span className="truncate">{label}</span>
		</label>
	);
}

const toggled = (list: string[], id: string, on: boolean): string[] =>
	on ? [...new Set([...list, id])] : list.filter((entry) => entry !== id);

// ------------------------------------------------------------------- groups

function GroupCard({ group, outs, users, run }: { group: TeamGroupInfo; outs: Out[]; users: TeamUserInfo[]; run: Run }) {
	const members = users.filter((user) => user.groups.includes(group.id)).map((user) => user.username);

	return (
		<section className="panel tm-group" data-group={group.id}>
			<header className="panel__head">
				<NameInput
					className="tm-group__name grow"
					label={t("Group name")}
					value={group.name}
					onCommit={(name) => run(request("PATCH", `/groups/${group.id}`, { name }))}
				/>
				<Menu
					label={t("Actions: {name}", { name: group.name })}
					items={[
						{
							label: t("Delete group"),
							icon: "trash",
							danger: true,
							onSelect: () => {
								if (window.confirm(t("Delete the group “{name}”? Its keys stop working.", { name: group.name }))) {
									run(request("DELETE", `/groups/${group.id}`));
								}
							},
						},
					]}
				/>
			</header>

			<div className="tm-block">
				<div className="tm-label">{t("Outs")}</div>
				{outs.length === 0 ? (
					<span className="hint">{t("There are no outs yet.")}</span>
				) : (
					<div className="tm-picks">
						{outs.map((out) => (
							<Pick
								key={out.id}
								label={out.name}
								checked={group.outs.includes(out.id)}
								onChange={(on) => run(request("PATCH", `/groups/${group.id}`, { outs: toggled(group.outs, out.id, on) }))}
							/>
						))}
					</div>
				)}
			</div>

			<div className="tm-block">
				<div className="tm-label">{t("Members")}</div>
				<span className={members.length === 0 ? "hint" : undefined}>
					{members.length === 0 ? t("Nobody yet — tick the group next to a user.") : members.join(", ")}
				</span>
			</div>

			<div className="tm-block">
				<div className="tm-label">{t("WebSocket keys")}</div>
				<span className="hint">{t("For Companion: a key sees and drives the outs of this group only.")}</span>
				{group.keys.map((key) => (
					<div className="tm-key" key={key.id} data-key={key.id}>
						<span className="tm-key__label truncate" title={key.label}>
							{key.label}
						</span>
						<input
							readOnly
							className="mono grow"
							aria-label={t("WebSocket key")}
							value={key.key}
							onFocus={(event) => event.target.select()}
						/>
						<CopyButton text={key.key} label={t("Copy")} className="small" />
						<IconButton
							icon="trash"
							label={t("Revoke this key")}
							className="small"
							onClick={() => {
								if (window.confirm(t("Revoke the key “{name}”? Whatever uses it is disconnected.", { name: key.label }))) {
									run(request("DELETE", `/groups/${group.id}/keys/${key.id}`));
								}
							}}
						/>
					</div>
				))}
				<div>
					<button
						type="button"
						className="ghost small"
						onClick={() => {
							const label = window.prompt(t("A name for the key — where it will be used:"), "Companion");
							if (label !== null) run(request("POST", `/groups/${group.id}/keys`, { label }));
						}}
					>
						<Icon name="plus" size={14} />
						{t("New key")}
					</button>
				</div>
			</div>
		</section>
	);
}

// -------------------------------------------------------------------- users

function UserRow({ user, groups, run }: { user: TeamUserInfo; groups: TeamGroupInfo[]; run: Run }) {
	if (user.builtin) {
		return (
			<div className="tm-user" data-user={user.username}>
				<div className="tm-user__head">
					<span className="tm-user__name truncate">{user.username}</span>
					<span className="hint">{t("administrator · set where the server is started")}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="tm-user" data-user={user.username}>
			<div className="tm-user__head">
				<span className="tm-user__name truncate">{user.username}</span>
				<select
					aria-label={t("Role of {name}", { name: user.username })}
					value={user.role}
					onChange={(event) => run(request("PATCH", `/users/${user.id}`, { role: event.target.value }))}
				>
					<option value="member">{t("member")}</option>
					<option value="admin">{t("administrator")}</option>
				</select>
				{user.defaultPassword ? <span className="err">{t("default password")}</span> : null}
				<span className="spacer" />
				<Menu
					label={t("Actions: {name}", { name: user.username })}
					items={[
						{
							label: t("Set a new password…"),
							icon: "lock",
							onSelect: () => changePassword(user, run),
						},
						{
							label: t("Delete user"),
							icon: "trash",
							danger: true,
							separated: true,
							onSelect: () => {
								if (window.confirm(t("Delete the user “{name}”? They are signed out at once.", { name: user.username }))) {
									run(request("DELETE", `/users/${user.id}`));
								}
							},
						},
					]}
				/>
			</div>
			{user.role === "admin" ? (
				<span className="hint">{t("An administrator sees every out and manages the team.")}</span>
			) : groups.length === 0 ? (
				<span className="hint">{t("Make a group first, then put the user in it.")}</span>
			) : (
				<div className="tm-picks">
					{groups.map((group) => (
						<Pick
							key={group.id}
							label={group.name}
							checked={user.groups.includes(group.id)}
							onChange={(on) =>
								run(request("PATCH", `/users/${user.id}`, { groups: toggled(user.groups, group.id, on) }))
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function NewUser({ run }: { run: Run }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const ready = username.trim() !== "" && password.length >= MIN_PASSWORD;

	return (
		<form
			className="tm-new"
			onSubmit={(event) => {
				event.preventDefault();
				if (!ready) return;
				run(request("POST", "/users", { username: username.trim(), password }));
				setUsername("");
				setPassword("");
			}}
		>
			<input
				className="grow"
				aria-label={t("Name of the new user")}
				placeholder={t("User name")}
				autoComplete="off"
				value={username}
				onChange={(event) => setUsername(event.target.value)}
			/>
			<input
				className="grow"
				type="password"
				aria-label={t("Password of the new user")}
				placeholder={t("Password, {n}+ characters", { n: MIN_PASSWORD })}
				autoComplete="new-password"
				value={password}
				onChange={(event) => setPassword(event.target.value)}
			/>
			<button type="submit" disabled={!ready}>
				<Icon name="plus" size={14} />
				{t("Add user")}
			</button>
		</form>
	);
}

// ---------------------------------------------------------------- OBS links

function OutLink({ out, run }: { out: Out; run: Run }) {
	const url = absoluteOutUrl(out.id);
	return (
		<div className="tm-link" data-out={out.id}>
			<span className="tm-link__name truncate">{out.name}</span>
			<input
				readOnly
				className="mono grow"
				aria-label={t("Address for the Browser Source in OBS")}
				value={url}
				onFocus={(event) => event.target.select()}
			/>
			<CopyButton text={url} label={t("Copy")} className="small" />
			<button
				type="button"
				className="ghost small"
				onClick={() => {
					if (window.confirm(t("Make a new link for “{name}”? The one in OBS stops working.", { name: out.name }))) {
						run(request("POST", `/outs/${out.id}/key`));
					}
				}}
			>
				{t("New link")}
			</button>
		</div>
	);
}

// ---------------------------------------------------------------------- app

function App() {
	const me = useMe();
	const outs = useAllOuts();
	const revision = useTeamRevision();
	const [team, setTeam] = useState<TeamState | undefined>();
	const [error, setError] = useState("");
	useLang();

	const admin = me?.role === "admin";
	const load = useCallback(() => {
		void fetch(`${TEAM_BASE}/state`, { headers: { accept: "application/json" } })
			.then((response) => (response.ok ? (response.json() as Promise<TeamState>) : undefined))
			.then((next) => {
				if (next) setTeam(next);
			})
			.catch(() => undefined);
	}, []);
	const outIds = outs.map((out) => out.id).join("\n");
	useEffect(() => {
		if (admin) load();
	}, [admin, load, revision, outIds]);

	const run: Run = (change) => {
		setError("");
		change.then(load, (reason: Error) => setError(reason.message));
	};

	const groups = team?.groups ?? [];
	const users = team?.users ?? [];

	const head = (
		<header className="tm-head">
			<h2>{t("Team")}</h2>
			<span className="hint truncate">{t("Who works on the show, and on which outs")}</span>
			<span className="spacer" />
			<ThemeSwitch />
			<LangSwitch />
		</header>
	);

	if (!me) return <div className="tm tm--single">{head}</div>;
	if (!admin) {
		return (
			<div className="tm tm--single">
				{head}
				<section className="panel">
					<div className="empty">
						{t("Only an administrator manages the team.")}{" "}
						{me.groups.length > 0
							? t("Your groups: {names}.", { names: me.groups.map((group) => group.name).join(", ") })
							: t("You are not in a group yet, so no outs are shared with you.")}
					</div>
				</section>
			</div>
		);
	}

	return (
		<div className="tm">
			<div className="tm-wide">
				{head}
				{error ? (
					<div className="err tm-error" role="alert">
						{error}
					</div>
				) : null}
				{me.defaultPassword ? (
					<section className="panel tm-warn" role="alert">
						<div className="grow">
							{t(
								"You are signed in with the default password. Until it is changed, anyone who can open this address gets in as {name} / {password}.",
								{ name: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password },
							)}
						</div>
						<button
							type="button"
							onClick={() => {
								const self = users.find((user) => user.username === me.username);
								if (self) changePassword(self, run);
							}}
						>
							{t("Change the password")}
						</button>
					</section>
				) : null}
				{me.login ? null : (
					<section className="panel">
						<div className="empty">
							{t(
								"The sign-in is off: whoever opens the dashboard is an administrator, and the OBS links need no key. Switch it on where the server is started — in the launcher or in .env — to give everyone a name of their own. Groups and their WebSocket keys work either way.",
							)}
						</div>
					</section>
				)}
			</div>

			<div className="tm-col">
				<header className="tm-head">
					<h2>{t("Groups")}</h2>
					<span className="hint truncate">{t("A group is a set of outs and the people who work with them")}</span>
					<span className="spacer" />
					<button type="button" onClick={() => run(request("POST", "/groups", { name: t("New group") }))}>
						<Icon name="plus" size={14} />
						{t("New group")}
					</button>
				</header>
				{groups.length === 0 ? (
					<section className="panel">
						<div className="empty">
							{t("No groups yet. Make one — “VJ”, “Streamer 1” — tick its outs, and give it a key for Companion.")}
						</div>
					</section>
				) : (
					groups.map((group) => <GroupCard key={group.id} group={group} outs={outs} users={users} run={run} />)
				)}
			</div>

			<div className="tm-col">
				{me.login ? (
					<>
						<header className="tm-head">
							<h2>{t("Users")}</h2>
						</header>
						<section className="panel tm-users">
							{users.map((user) => (
								<UserRow key={user.id} user={user} groups={groups} run={run} />
							))}
							<NewUser run={run} />
						</section>

						<header className="tm-head">
							<h2>{t("OBS links")}</h2>
							<span className="hint truncate">{t("One out — one link. It opens that out and nothing else")}</span>
						</header>
						<section className="panel tm-links">
							{outs.length === 0 ? (
								<div className="empty">{t("There are no outs yet.")}</div>
							) : (
								outs.map((out) => <OutLink key={out.id} out={out} run={run} />)
							)}
						</section>
					</>
				) : null}
			</div>
		</div>
	);
}

const container = document.getElementById("notgt-root");
if (container) createRoot(container).render(<App />);
