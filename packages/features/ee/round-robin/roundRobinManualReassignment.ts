// eslint-disable-next-line no-restricted-imports
import { cloneDeep } from "lodash";

import { OrganizerDefaultConferencingAppType, getLocationValueForDB } from "@calcom/app-store/locations";
import EventManager from "@calcom/core/EventManager";
import { getEventName } from "@calcom/core/event";
import dayjs from "@calcom/dayjs";
import { sendRoundRobinCancelledEmailsAndSMS, sendRoundRobinScheduledEmailsAndSMS } from "@calcom/emails";
import getBookingResponsesSchema from "@calcom/features/bookings/lib/getBookingResponsesSchema";
import { getCalEventResponses } from "@calcom/features/bookings/lib/getCalEventResponses";
import { getEventTypesFromDB } from "@calcom/features/bookings/lib/handleNewBooking/getEventTypesFromDB";
import {
  scheduleEmailReminder,
  deleteScheduledEmailReminder,
} from "@calcom/features/ee/workflows/lib/reminders/emailReminderManager";
import { scheduleWorkflowReminders } from "@calcom/features/ee/workflows/lib/reminders/reminderScheduler";
import { isPrismaObjOrUndefined } from "@calcom/lib";
import { getVideoCallUrlFromCalEvent } from "@calcom/lib/CalEventParser";
import { getBookerBaseUrl } from "@calcom/lib/getBookerUrl/server";
import logger from "@calcom/lib/logger";
import { getTranslation } from "@calcom/lib/server/i18n";
import { BookingReferenceRepository } from "@calcom/lib/server/repository/bookingReference";
import { getTimeFormatStringFromUserTimeFormat } from "@calcom/lib/timeFormat";
import { prisma } from "@calcom/prisma";
import { WorkflowActions, WorkflowMethods, WorkflowTriggerEvents } from "@calcom/prisma/enums";
import { userMetadata as userMetadataSchema } from "@calcom/prisma/zod-utils";
import type { EventTypeMetadata } from "@calcom/prisma/zod-utils";
import type { CalendarEvent } from "@calcom/types/Calendar";

import type { BookingSelectResult } from "./utils/bookingSelect";
import { bookingSelect } from "./utils/bookingSelect";
import { getDestinationCalendar } from "./utils/getDestinationCalendar";
import { getTeamMembers } from "./utils/getTeamMembers";

enum ErrorCode {
  InvalidRoundRobinHost = "invalid_round_robin_host",
  UserIsFixed = "user_is_round_robin_fixed",
}

export const roundRobinManualReassignment = async ({
  bookingId,
  newUserId,
  orgId,
}: {
  bookingId: number;
  newUserId: number;
  orgId: number | null;
}) => {
  const roundRobinReassignLogger = logger.getSubLogger({
    prefix: ["roundRobinManualReassign", `${bookingId}`],
  });

  let booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: bookingSelect,
  });

  if (!booking || !booking.user) {
    roundRobinReassignLogger.error(`Booking ${bookingId} not found or has no associated user`);
    throw new Error("Booking not found or has no associated user");
  }

  const eventTypeId = booking.eventTypeId;
  if (!eventTypeId) {
    roundRobinReassignLogger.error(`Booking ${bookingId} does not have an event type id`);
    throw new Error("Event type not found");
  }

  const eventType = await getEventTypesFromDB(eventTypeId);
  if (!eventType) {
    roundRobinReassignLogger.error(`Event type ${eventTypeId} not found`);
    throw new Error("Event type not found");
  }

  const eventTypeHosts = eventType.hosts.length
    ? eventType.hosts
    : eventType.users.map((user) => ({
        user,
        isFixed: false,
        priority: 2,
        weight: 100,
        weightAdjustment: 0,
        schedule: null,
      }));

  const fixedHost = eventTypeHosts.find((host) => host.isFixed);
  const currentRRHost = booking.attendees.find((attendee) =>
    eventTypeHosts.some((host) => !host.isFixed && host.user.email === attendee.email)
  );
  const newUserHost = eventTypeHosts.find((host) => host.user.id === newUserId);

  if (!newUserHost) {
    throw new Error(ErrorCode.InvalidRoundRobinHost);
  }

  if (newUserHost.isFixed) {
    throw new Error(ErrorCode.UserIsFixed);
  }

  const originalOrganizer = booking.user;
  const hasOrganizerChanged = !fixedHost && booking.userId !== newUserId;

  const newUser = newUserHost.user;
  const newUserT = await getTranslation(newUser.locale || "en", "common");
  const originalOrganizerT = await getTranslation(originalOrganizer.locale || "en", "common");

  if (hasOrganizerChanged) {
    const bookingResponses = booking.responses;
    const responseSchema = getBookingResponsesSchema({
      bookingFields: eventType.bookingFields,
      view: "reschedule",
    });
    const responseSafeParse = await responseSchema.safeParseAsync(bookingResponses);
    const responses = responseSafeParse.success ? responseSafeParse.data : undefined;

    let bookingLocation = booking.location;
    if (eventType.locations.includes({ type: OrganizerDefaultConferencingAppType })) {
      const newUserMetadataSafeParse = userMetadataSchema.safeParse(newUser.metadata);
      const defaultLocationUrl = newUserMetadataSafeParse.success
        ? newUserMetadataSafeParse?.data?.defaultConferencingApp?.appLink
        : undefined;
      const currentBookingLocation = booking.location || "integrations:daily";
      bookingLocation =
        defaultLocationUrl ||
        getLocationValueForDB(currentBookingLocation, eventType.locations).bookingLocation;
    }

    const newBookingTitle = getEventName({
      attendeeName: responses?.name || "Nameless",
      eventType: eventType.title,
      eventName: eventType.eventName,
      teamName: eventType.team?.name,
      host: newUser.name || "Nameless",
      location: bookingLocation || "integrations:daily",
      bookingFields: { ...responses },
      eventDuration: eventType.length,
      t: newUserT,
    });

    booking = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        userId: newUserId,
        title: newBookingTitle,
        userPrimaryEmail: newUser.email,
      },
      select: bookingSelect,
    });
  } else if (currentRRHost) {
    // Update the round-robin host attendee
    await prisma.attendee.update({
      where: { id: currentRRHost.id },
      data: {
        name: newUser.name || "",
        email: newUser.email,
        timeZone: newUser.timeZone,
        locale: newUser.locale,
      },
    });
  }

  const destinationCalendar = await getDestinationCalendar({
    eventType,
    booking,
    newUserId,
    hasOrganizerChanged,
  });

  const teamMembers = await getTeamMembers({
    eventTypeHosts,
    attendees: booking.attendees,
    organizer: newUser,
    previousHost: originalOrganizer,
    reassignedHost: newUser,
  });

  const attendeePromises = booking.attendees.map(async (attendee) => ({
    email: attendee.email,
    name: attendee.name,
    timeZone: attendee.timeZone,
    language: {
      translate: await getTranslation(attendee.locale ?? "en", "common"),
      locale: attendee.locale ?? "en",
    },
    phoneNumber: attendee.phoneNumber || undefined,
  }));

  const attendeeList = await Promise.all(attendeePromises);

  const evt: CalendarEvent = {
    type: eventType.slug,
    title: booking.title,
    description: eventType.description,
    startTime: dayjs(booking.startTime).utc().format(),
    endTime: dayjs(booking.endTime).utc().format(),
    organizer: {
      email: newUser.email,
      name: newUser.name || "",
      timeZone: newUser.timeZone,
      language: { translate: newUserT, locale: newUser.locale || "en" },
    },
    attendees: attendeeList,
    uid: booking.uid,
    destinationCalendar,
    team: {
      members: teamMembers,
      name: eventType.team?.name || "",
      id: eventType.team?.id || 0,
    },
    customInputs: isPrismaObjOrUndefined(booking.customInputs),
    ...getCalEventResponses({
      bookingFields: eventType.bookingFields ?? null,
      booking,
    }),
    cancellationReason: "Manually re-assigned",
  };

  const credentials = await prisma.credential.findMany({
    where: { userId: newUser.id },
    include: { user: { select: { email: true } } },
  });

  const eventManager = new EventManager({ ...newUser, credentials });
  const previousHostDestinationCalendar = hasOrganizerChanged
    ? await prisma.destinationCalendar.findFirst({
        where: { userId: originalOrganizer.id },
      })
    : null;

  const results = await eventManager.reschedule(
    evt,
    booking.uid,
    undefined,
    hasOrganizerChanged,
    previousHostDestinationCalendar ? [previousHostDestinationCalendar] : []
  );

  const newReferencesToCreate = structuredClone(results.referencesToCreate);

  await BookingReferenceRepository.replaceBookingReferences({
    bookingId,
    newReferencesToCreate,
  });

  // Send emails
  await sendRoundRobinScheduledEmailsAndSMS(evt, [
    {
      ...newUser,
      name: newUser.name || "",
      username: newUser.username || "",
      timeFormat: getTimeFormatStringFromUserTimeFormat(newUser.timeFormat),
      language: { translate: newUserT, locale: newUser.locale || "en" },
    },
  ]);

  // Send cancellation email to original organizer
  const cancelledEvt = cloneDeep(evt);
  cancelledEvt.organizer = {
    email: originalOrganizer.email,
    name: originalOrganizer.name || "",
    timeZone: originalOrganizer.timeZone,
    language: { translate: originalOrganizerT, locale: originalOrganizer.locale || "en" },
  };

  await sendRoundRobinCancelledEmailsAndSMS(
    cancelledEvt,
    [
      {
        ...originalOrganizer,
        name: originalOrganizer.name || "",
        username: originalOrganizer.username || "",
        timeFormat: getTimeFormatStringFromUserTimeFormat(originalOrganizer.timeFormat),
        language: { translate: originalOrganizerT, locale: originalOrganizer.locale || "en" },
      },
    ],
    eventType?.metadata as EventTypeMetadata
  );

  if (hasOrganizerChanged) {
    // Handle changing workflows with organizer
    await handleWorkflowsUpdate({
      booking,
      newUser,
      evt,
      eventType,
      orgId,
    });
  }

  return booking;
};

async function handleWorkflowsUpdate({
  booking,
  newUser,
  evt,
  eventType,
  orgId,
}: {
  booking: BookingSelectResult;
  newUser: {
    id: number;
    email: string;
    locale?: string | null;
  };
  evt: CalendarEvent;
  eventType: Awaited<ReturnType<typeof getEventTypesFromDB>>;
  orgId: number | null;
}) {
  const workflowReminders = await prisma.workflowReminder.findMany({
    where: {
      bookingUid: booking.uid,
      method: WorkflowMethods.EMAIL,
      workflowStep: {
        action: WorkflowActions.EMAIL_HOST,
        workflow: {
          trigger: {
            in: [
              WorkflowTriggerEvents.BEFORE_EVENT,
              WorkflowTriggerEvents.NEW_EVENT,
              WorkflowTriggerEvents.AFTER_EVENT,
            ],
          },
        },
      },
    },
    select: {
      id: true,
      referenceId: true,
      workflowStep: {
        select: {
          template: true,
          workflow: {
            select: {
              trigger: true,
              time: true,
              timeUnit: true,
            },
          },
        },
      },
    },
  });

  const workflowEventMetadata = { videoCallUrl: getVideoCallUrlFromCalEvent(evt) };
  const bookerUrl = await getBookerBaseUrl(orgId);

  for (const workflowReminder of workflowReminders) {
    const workflowStep = workflowReminder?.workflowStep;
    const workflow = workflowStep?.workflow;

    if (workflowStep && workflow) {
      await scheduleEmailReminder({
        evt: {
          ...evt,
          metadata: workflowEventMetadata,
          eventType,
          bookerUrl,
        },
        action: WorkflowActions.EMAIL_HOST,
        triggerEvent: workflow.trigger,
        timeSpan: {
          time: workflow.time,
          timeUnit: workflow.timeUnit,
        },
        sendTo: newUser.email,
        template: workflowStep.template,
      });
    }

    await deleteScheduledEmailReminder(workflowReminder.id, workflowReminder.referenceId);
  }

  // Send new event workflows to new organizer
  const newEventWorkflows = await prisma.workflow.findMany({
    where: {
      trigger: WorkflowTriggerEvents.NEW_EVENT,
      OR: [
        {
          isActiveOnAll: true,
          teamId: eventType?.teamId,
        },
        {
          activeOn: {
            some: {
              eventTypeId: eventType.id,
            },
          },
        },
        ...(eventType?.teamId
          ? [
              {
                activeOnTeams: {
                  some: {
                    teamId: eventType.teamId,
                  },
                },
              },
            ]
          : []),
        ...(eventType?.team?.parentId
          ? [
              {
                isActiveOnAll: true,
                teamId: eventType.team.parentId,
              },
            ]
          : []),
      ],
    },
    include: {
      steps: {
        where: {
          action: WorkflowActions.EMAIL_HOST,
        },
      },
    },
  });

  await scheduleWorkflowReminders({
    workflows: newEventWorkflows,
    smsReminderNumber: null,
    calendarEvent: {
      ...evt,
      metadata: workflowEventMetadata,
      eventType: { slug: eventType.slug },
      bookerUrl,
    },
    hideBranding: !!eventType?.owner?.hideBranding,
  });
}

export default roundRobinManualReassignment;
