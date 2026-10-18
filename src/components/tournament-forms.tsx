"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { registerTeamAction, saveTournamentAction, updateRosterAction } from "@/actions/tournaments";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export interface TournamentDefaults {
  id?: string;
  name?: string;
  game?: string;
  description?: string;
  format?: string;
  teamSize?: string;
  maxSubstitutes?: string;
  maxTeams?: string;
  /** datetime-local values, Stockholm time */
  registrationClosesAt?: string;
  startsAt?: string;
  eventId?: string;
  status?: string;
}

/** Create or edit a tournament (Festivalledare / Admin). */
export function TournamentForm({ events, defaults = {}, teamSizeLocked = false }: { events: { id: string; name: string }[]; defaults?: TournamentDefaults; teamSizeLocked?: boolean }) {
  const t = useTranslations("tournamentsManage");
  const tt = useTranslations("tournaments");
  const [state, action] = useActionState(saveTournamentAction, initial);
  const uid = defaults.id ?? "new";
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label={t("name")} state={state} required defaultValue={defaults.name} maxLength={100} />
        <Field name="game" label={t("game")} state={state} required defaultValue={defaults.game} maxLength={60} />
      </div>
      <TextAreaField name="description" label={t("description")} state={state} defaultValue={defaults.description} rows={5} />
      <Field name="format" label={t("format")} hint={t("formatHint")} state={state} optional defaultValue={defaults.format} maxLength={200} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field name="teamSize" label={t("teamSize")} hint={teamSizeLocked ? t("teamSizeLocked") : t("teamSizeHint")} state={state} required defaultValue={defaults.teamSize ?? "5"} inputMode="numeric" maxLength={2} />
        <Field name="maxSubstitutes" label={t("maxSubstitutes")} hint={t("maxSubstitutesHint")} state={state} required defaultValue={defaults.maxSubstitutes ?? "1"} inputMode="numeric" maxLength={2} />
        <Field name="maxTeams" label={t("maxTeams")} hint={t("maxTeamsHint")} state={state} optional defaultValue={defaults.maxTeams} inputMode="numeric" maxLength={4} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="registrationClosesAt" label={t("closesAt")} hint={t("closesAtHint")} type="datetime-local" state={state} required defaultValue={defaults.registrationClosesAt} />
        <Field name="startsAt" label={t("startsAt")} hint={t("startsAtHint")} type="datetime-local" state={state} optional defaultValue={defaults.startsAt} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`tn-event-${uid}`} className="block text-sm font-medium">{t("event")}</label>
          <select id={`tn-event-${uid}`} name="eventId" className="input" defaultValue={state.values?.eventId ?? defaults.eventId ?? ""}>
            <option value="">{t("noEvent")}</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`tn-status-${uid}`} className="block text-sm font-medium">{t("status")}</label>
          <select id={`tn-status-${uid}`} name="status" className="input" defaultValue={state.values?.status ?? defaults.status ?? "DRAFT"}>
            {(["DRAFT", "PUBLISHED", "CANCELLED"] as const).map((s) => (
              <option key={s} value={s}>{tt(`status_${s}`)}</option>
            ))}
          </select>
        </div>
      </div>
      <SubmitButton>{defaults.id ? t("save") : t("create")}</SubmitButton>
    </form>
  );
}

export interface RegisterableTeam {
  id: string;
  name: string;
  members: { id: string; nickname: string }[];
}

/** One checkbox per team member, with a live count against the allowed roster size. */
function RosterPicker({ members, min, max, initial: chosenInitial }: { members: { id: string; nickname: string }[]; min: number; max: number; initial: string[] }) {
  const t = useTranslations("tournaments");
  const [chosen, setChosen] = useState<string[]>(chosenInitial);
  const ok = chosen.length >= min && chosen.length <= max;
  return (
    <fieldset className="space-y-2" aria-describedby="roster-count">
      <legend className="mb-1 text-sm font-medium">{t("roster")}</legend>
      {members.map((m) => (
        <label key={m.id} className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            name="player"
            value={m.id}
            className="h-5 w-5"
            checked={chosen.includes(m.id)}
            onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))}
          />
          {m.nickname}
        </label>
      ))}
      <p id="roster-count" role="status" className={`text-sm font-bold ${ok ? "" : "text-barn"}`}>
        {t("rosterCount", { count: chosen.length, min, max })}
      </p>
    </fieldset>
  );
}

/** A captain enters one of their teams. */
export function RegisterTeamForm({ tournamentId, teams, min, max }: { tournamentId: string; teams: RegisterableTeam[]; min: number; max: number }) {
  const t = useTranslations("tournaments");
  const [state, action] = useActionState(registerTeamAction, initial);
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const team = teams.find((x) => x.id === teamId) ?? teams[0];
  if (!team) return null;
  return (
    <form action={action} className="space-y-4">
      <FormMessage state={state} />
      <input type="hidden" name="tournamentId" value={tournamentId} />
      {teams.length > 1 && (
        <div>
          <label htmlFor="reg-team" className="block text-sm font-medium">{t("chooseTeam")}</label>
          <select id="reg-team" name="teamId" className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </div>
      )}
      {teams.length === 1 && <input type="hidden" name="teamId" value={team.id} />}
      {/* key: a different team means a different list of people */}
      <RosterPicker key={team.id} members={team.members} min={min} max={max} initial={team.members.slice(0, min).map((m) => m.id)} />
      <SubmitButton>{t("register")}</SubmitButton>
    </form>
  );
}

/** Change the roster of a team that is already entered. */
export function RosterForm({ registrationId, members, chosen, min, max }: { registrationId: string; members: { id: string; nickname: string }[]; chosen: string[]; min: number; max: number }) {
  const t = useTranslations("tournaments");
  const [state, action] = useActionState(updateRosterAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage state={state} />
      <input type="hidden" name="registrationId" value={registrationId} />
      <RosterPicker members={members} min={min} max={max} initial={chosen} />
      <SubmitButton variant="btn-secondary">{t("saveRoster")}</SubmitButton>
    </form>
  );
}
