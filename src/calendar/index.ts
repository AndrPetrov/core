// Strautomator Core: Calendar

import {CalendarOptions} from "./types"
import {UserCalendarTemplate, UserData} from "../users/types"
import {recipePropertyList} from "../recipes/lists"
import {StravaClub} from "../strava/types"
import {getSportIcon, transformActivityFields} from "../strava/utils"
import {translation} from "../translations"
import {File} from "@google-cloud/storage"
import _ from "lodash"
import crypto = require("crypto")
import eventManager from "../eventmanager"
import komoot from "../komoot"
import maps from "../maps"
import storage from "../storage"
import strava from "../strava"
import ical, {ICalCalendar, ICalAttendeeType, ICalAttendeeRole, ICalAttendeeStatus, ICalEventData} from "ical-generator"
import jaul = require("jaul")
import logger = require("anyhow")
import dayjs from "../dayjs"
const settings = require("setmeup").settings

/**
 * Messages manager.
 */
export class Calendar {
    private constructor() {}
    private static _instance: Calendar
    static get Instance() {
        return this._instance || (this._instance = new this())
    }

    // INIT
    // --------------------------------------------------------------------------

    /**
     * Init the Calendar manager.
     */
    init = async (): Promise<void> => {
        try {
            const durationFree = dayjs.duration(settings.plans.free.calendarCacheDuration, "seconds").humanize()
            const durationPro = dayjs.duration(settings.plans.pro.calendarCacheDuration, "seconds").humanize()

            logger.info("Calendar.init", `Cache durations: Free ${durationFree}, PRO ${durationPro}`)
            eventManager.on("Users.delete", this.onUserDelete)
        } catch (ex) {
            logger.error("Calendar.init", ex)
            throw ex
        }
    }

    /**
     * Delete cached calendars when an user account is deleted.
     * @param user User that was deleted from the database.
     */
    private onUserDelete = async (user: UserData): Promise<void> => {
        try {
            const calendarFiles = await storage.listFiles("calendar", `${user.id}/`)

            if (calendarFiles.length > 0) {
                const count = calendarFiles.length

                for (let file of calendarFiles) {
                    await file.delete()
                }

                logger.info("Calendar.onUsersDelete", `User ${user.id} ${user.displayName}`, `Deleted ${count} cached calendars`)
            }
        } catch (ex) {
            logger.error("Calendar.onUsersDelete", `User ${user.id} ${user.displayName}`, ex)
        }
    }

    // GENERATION
    // --------------------------------------------------------------------------

    /**
     * Generate the Strautomator calendar and return its iCal string representation.
     * Returns the URL to the generated calendar.
     * @param user The user requesting the calendar.
     * @param options Calendar generation options.
     * @param res Response object.
     */
    generate = async (user: UserData, options: CalendarOptions): Promise<string> => {
        let optionsLog: string
        let cacheId: string
        let cachedFile: File

        try {
            if (!options) throw new Error("Missing calendar options")

            // Check and set default options.
            if (!options.sportTypes || options.sportTypes.length == 0) {
                delete options.sportTypes
            }

            optionsLog = _.map(_.toPairs(options), (r) => r.join("=")).join(" | ")

            // Days and timestamp calculations.
            const nowUtc = dayjs.utc()
            const pastDays = user.isPro ? settings.plans.pro.pastCalendarDays : settings.plans.free.pastCalendarDays
            const futureDays = user.isPro ? settings.plans.pro.futureCalendarDays : settings.plans.free.futureCalendarDays
            const minDate = nowUtc.startOf("day").subtract(pastDays, "days").subtract(1, "millisecond")
            const maxDate = nowUtc.endOf("day").add(futureDays, "days").subtract(1, "millisecond")
            const defaultFromDate = nowUtc.subtract(settings.plans.free.pastCalendarDays, "days").startOf("day")
            let dateFrom = options.dateFrom ? dayjs(options.dateFrom) : defaultFromDate
            let dateTo = options.dateTo ? dayjs(options.dateTo) : maxDate

            // Date validation checks.
            if (minDate.isAfter(dateFrom)) {
                logger.warn("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, `Force setting past days to ${pastDays}`)
                dateFrom = minDate
            }
            if (maxDate.isAfter(dateTo)) {
                logger.warn("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, `Force setting future days to ${futureDays}`)
                dateTo = maxDate
            }

            const startTime = dayjs().unix()

            // Use "default" if no options were passed, otherwise get a hash to fetch the correct cached calendar.
            // Append -beta to the hash code in Beta environments.
            let hash = crypto.createHash("sha1").update(JSON.stringify(options, null, 0)).digest("hex").substring(0, 14)
            if (settings.beta.enabled) hash += "-beta"

            cacheId = `${user.id}/${user.urlToken}-${hash}.ics`
            cachedFile = await storage.getFile("calendar", cacheId)

            // See if cached version of the calendar is still valid.
            // Check cached calendar expiry date (reversed / backwards) and if user has
            // new activity since the last generated output.
            if (cachedFile) {
                try {
                    const [metadata] = await cachedFile.getMetadata()
                    const cacheTimestamp = dayjs.utc(metadata.timeCreated).valueOf()
                    const cacheSize = metadata.size
                    const onlyClubs = options.clubs && !options.activities

                    // Calculate the correct cache duration.
                    let cacheDuration = user.isPro ? settings.plans.pro.calendarCacheDuration : settings.plans.free.calendarCacheDuration
                    if (user.isPro && options.shorterCache) {
                        cacheDuration = cacheDuration / 2
                    }
                    if (onlyClubs && options.clubIds?.length == 1) {
                        cacheDuration = cacheDuration / 2
                    }

                    // Additional cache validation.
                    const expiryDate = nowUtc.subtract(cacheDuration, "seconds").toDate()
                    const maxExpiryDate = nowUtc.subtract(settings.calendar.maxCacheDuration + cacheDuration, "seconds").toDate()
                    const notExpired = expiryDate.valueOf() < cacheTimestamp
                    const lastActivity = user.dateLastActivity ? user.dateLastActivity.valueOf() : 0
                    const notChanged = lastActivity < cacheTimestamp && maxExpiryDate.valueOf() <= cacheTimestamp

                    // Return cached calendar if it has not expired, and has not changed
                    // or if calendar is for club events only.
                    if (notExpired && (notChanged || onlyClubs)) {
                        logger.info("Calendar.generate.fromCache", `User ${user.id} ${user.displayName}`, optionsLog, `${(cacheSize / 1000 / 1024).toFixed(2)} MB`)
                        return storage.getUrl("calendar", cacheId)
                    } else {
                        logger.info("Calendar.generate.fromCache", `User ${user.id} ${user.displayName}`, optionsLog, "Cache invalidated, will generate a new calendar")
                    }
                } catch (cacheEx) {
                    logger.error("Calendar.generate.fromCache", `User ${user.id} ${user.displayName}`, optionsLog, cacheEx)
                }
            }

            logger.info("Calendar.generate", `User ${user.id} ${user.displayName}`, optionsLog)

            // Set calendar name based on passed filters.
            let calName = settings.calendar.name
            if (!options.activities) calName += ` clubs`
            if (!options.clubs) calName += ` activities`
            if (options.sportTypes) calName += ` (${options.sportTypes.join(", ")})`

            // Prepare calendar details.
            const domain = new URL(settings.app.url).hostname
            const prodId = {company: "Devv", product: "Strautomator", language: "EN"}
            const calUrl = `${settings.app.url}calendar/${user.urlToken}`

            // Create ical container.
            const icalOptions = {
                name: calName,
                domain: domain,
                prodId: prodId,
                url: calUrl,
                ttl: user.isPro ? settings.plans.pro.calendarCacheDuration : settings.plans.free.calendarCacheDuration
            }
            const cal = ical(icalOptions)

            // Force set the dates from and to so we can build the activities / club events.
            options.dateFrom = dateFrom
            options.dateTo = dateTo

            // User is suspended? Add a single event, otherwise process activities and club events.
            if (user.suspended) {
                const soon = dayjs().add(8, "hours")
                const later = dayjs().add(36, "hours")

                for (let date of [soon, later]) {
                    cal.createEvent({
                        start: date.toDate(),
                        end: date.add(1, "hour").toDate(),
                        summary: "Strautomator account is suspended!",
                        description: "Your Strautomator account is suspended!\n\nTo reactivate it and enable the calendar, please login again at strautomator.com.",
                        url: "https://strautomator.com/auth/login"
                    })
                }
            } else {
                if (options.activities) {
                    await this.buildActivities(user, options, cal)
                }
                if (options.clubs) {
                    await this.buildClubs(user, options, cal)
                }
            }

            const output = cal.toString()
            const duration = dayjs().unix() - startTime
            const size = output.length / 1000 / 1024

            try {
                await storage.setFile("calendar", cacheId, output, "text/calendar")
            } catch (saveEx) {
                logger.error("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, "Failed to save to the cache")
            }

            logger.info("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, `${cal.events().length} events`, `${size.toFixed(2)} MB`, `Generated in ${duration} seconds`)

            return storage.getUrl("calendar", cacheId)
        } catch (ex) {
            if (cachedFile) {
                logger.error("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, ex, "Fallback to cached calendar")
                return storage.getUrl("calendar", cacheId)
            } else {
                logger.error("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, ex)
                throw ex
            }
        }
    }

    /**
     * Build the user activities events in the calendar.
     * @param user The user.
     * @param options Calendar options.
     * @param cal The ical instance.
     */
    private buildActivities = async (user: UserData, options: CalendarOptions, cal: ICalCalendar): Promise<void> => {
        const optionsLog = `From ${options.dateFrom.format("ll")} to ${options.dateTo.format("ll")}`
        let eventCount = 0

        try {
            const calendarTemplate: UserCalendarTemplate = user.calendarTemplate || {}

            // Fetch and iterate user activities, checking filters before proceeding.
            const activities = await strava.activities.getActivities(user, {after: options.dateFrom, before: options.dateTo})
            for (let activity of activities) {
                const arrDetails = []

                // Stop here if the activity was excluded on the calendar options.
                if (options.sportTypes && !options.sportTypes.includes(activity.sportType)) continue
                if (options.excludeCommutes && activity.commute) continue

                // For whatever reason Strava sometimes returned no dates on activities, so adding this extra check here
                // that should go away once the root cause is identified.
                if (!activity.dateStart || !activity.dateEnd) {
                    logger.info("Calendar.generate", `User ${user.id} ${user.displayName}`, `Activity ${activity.id} has no start or end date`)
                    continue
                }

                // Activity start and end dates.
                const startDate = activity.dateStart
                const endDate = activity.dateEnd

                // Append suffixes to activity values.
                transformActivityFields(user, activity)

                // If no event details template was set, push default values to the details array.
                if (!calendarTemplate.eventDetails) {
                    if (activity.commute) {
                        arrDetails.push("Commute")
                    }

                    // Iterate default fields to be added to the event details.
                    for (let f of settings.calendar.activityFields) {
                        const subDetails = []
                        const arrFields = f.split(",")

                        for (let field of arrFields) {
                            field = field.trim()

                            if (activity[field]) {
                                const fieldInfo = _.find(recipePropertyList, {value: field})
                                const fieldName = fieldInfo ? fieldInfo.text : field.charAt(0).toUpperCase() + field.slice(1)
                                subDetails.push(`${fieldName}: ${activity[field]}`)
                            }

                            arrDetails.push(subDetails.join(" - "))
                        }
                    }
                }

                // Replace boolean tags with yes or no.
                for (let field of Object.keys(activity)) {
                    if (activity[field] === true) activity[field] = "yes"
                    else if (activity[field] === false) activity[field] = "no"
                }

                // Get summary and details from options or from defaults.
                try {
                    const summaryTemplate = calendarTemplate?.eventSummary || settings.calendar.eventSummary
                    const summary = jaul.data.replaceTags(summaryTemplate, activity)
                    const details = calendarTemplate.eventDetails ? jaul.data.replaceTags(calendarTemplate.eventDetails, activity) : arrDetails.join("\n")

                    // Add activity to the calendar as an event.
                    const event = cal.createEvent({
                        id: `activity-${activity.id}`,
                        start: startDate,
                        end: endDate,
                        summary: summary,
                        description: details,
                        url: `https://www.strava.com/activities/${activity.id}`
                    })

                    // Geo location available?
                    if (activity.locationEnd?.length > 0) {
                        let locationString: string = activity.locationEnd.join(", ")

                        // PRO users will have the location parsed into an address.
                        if (user.isPro) {
                            try {
                                const address = await maps.getReverseGeocode(activity.locationEnd)
                                delete address.state
                                delete address.dateCached
                                delete address.dateExpiry

                                // City available? Then we don't need to add the country,
                                // so we keep the string output small.
                                if (address.city) {
                                    delete address.country
                                }

                                locationString = Object.values(address).join(", ")
                            } catch (locationEx) {
                                logger.error("Calendar.buildActivities", `User ${user.id} ${user.displayName}`, `Activity ${activity.id}`, `Can't fetch address for ${locationString}`)
                            }
                        }

                        event.location(locationString)
                    }
                } catch (innerEx) {
                    logger.error("Calendar.buildActivities", `User ${user.id} ${user.displayName}`, `Activity ${activity.id}`, innerEx)
                }

                eventCount++
            }

            logger.debug("Calendar.buildActivities", `User ${user.id} ${user.displayName}`, optionsLog, `Got ${eventCount} activity events`)
        } catch (ex) {
            logger.error("Calendar.buildActivities", `User ${user.id} ${user.displayName}`, optionsLog, ex)
        }
    }

    /**
     * Build the club events in the calendar.
     * @param user The user.
     * @param options Calendar options.
     * @param cal The ical instance.
     */
    private buildClubs = async (user: UserData, options: CalendarOptions, cal: ICalCalendar): Promise<void> => {
        const optionsLog = `From ${options.dateFrom.format("ll")} to ${options.dateFrom.format("ll")}`
        const today = dayjs().hour(0).toDate()
        const tOrganizer = translation("Organizer", user.preferences, true)

        try {
            let eventCount = 0

            // Helper to process club events.
            const getEvents = async (club: StravaClub) => {
                if (!options.includeAllCountries && club.country != user.profile.country) {
                    logger.debug("Calendar.buildClubs", `User ${user.id} ${user.displayName}`, `Club ${club.id} from another country (${club.country}), skip it`)
                    return
                }

                const clubEvents = await strava.clubs.getClubEvents(user, club.id)

                for (let clubEvent of clubEvents) {
                    if (options.sportTypes && !options.sportTypes.includes(clubEvent.type)) continue
                    if (options.excludeNotJoined && !clubEvent.joined) continue

                    // Check if event has future dates.
                    const hasFutureDate = clubEvent.dates.find((d) => d > today)

                    // Club has a route set? Fetch the full route details. PRO users will also
                    // get distance and times from Komoot routes.
                    if (hasFutureDate) {
                        if (clubEvent.route && clubEvent.route.id) {
                            try {
                                clubEvent.route = await strava.routes.getRoute(user, clubEvent.route.idString)
                            } catch (routeEx) {
                                logger.warn("Calendar.buildClubs", `User ${user.id} ${user.displayName}`, `Failed to fetch route for event ${clubEvent.id}`)
                            }
                        } else if (user.isPro && clubEvent.description && clubEvent.description.length > 30) {
                            const url = komoot.extractRouteUrl(clubEvent.description)

                            if (url) {
                                const kRoute = await komoot.getRoute(user, url)

                                if (kRoute) {
                                    logger.info("Strava.buildClubs", `User ${user.id} ${user.displayName}`, `Event ${clubEvent.title}`, `Komoot route: ${kRoute.id}`)
                                    clubEvent.komootRoute = kRoute
                                }
                            }
                        }
                    }

                    // Iterate event dates and add each one of them to the calendar.
                    for (let eventDate of clubEvent.dates) {
                        if (options.dateFrom.isAfter(eventDate) || options.dateTo.isBefore(eventDate)) continue
                        let endDate: Date

                        const evTimestamp = Math.round(eventDate.valueOf() / 1000)
                        const estimatedTime = clubEvent.route ? clubEvent.route.estimatedTime : clubEvent.komootRoute ? clubEvent.komootRoute.estimatedTime : 0

                        // Upcoming event has a route with estimated time? Use it as the end date,
                        // with some added time for breaks / stops. Otherwise defaults to 15 minutes.
                        if (eventDate > today && estimatedTime > 0) {
                            const secondsEstimated = estimatedTime * 1.05
                            const secondsExtraBrakes = Math.floor(estimatedTime / 7200) * 60 * 20
                            const totalAddedSeconds = clubEvent.type == "Ride" ? secondsEstimated + secondsExtraBrakes : secondsEstimated + 300
                            const targetDate = dayjs(eventDate).add(totalAddedSeconds, "seconds")

                            // Round to 15min.
                            const toQuarter = 15 - (targetDate.minute() % 15)
                            endDate = targetDate.add(toQuarter, "minutes").toDate()
                        } else {
                            endDate = dayjs(eventDate).add(settings.calendar.defaultDurationMinutes, "minutes").toDate()
                        }

                        const eventLink = `https://www.strava.com/clubs/${club.id}/group_events/${clubEvent.id}`
                        const organizer = clubEvent.organizer ? `${clubEvent.organizer.firstName} ${clubEvent.organizer.lastName}` : null

                        // Add all relevant details to the event description.
                        const arrDescription = [`${club.name}\n`]
                        if (clubEvent.description) {
                            arrDescription.push(`${clubEvent.description}\n`)
                        }
                        if (clubEvent.joined) {
                            arrDescription.push("Attending: yes")
                        }
                        if (organizer) {
                            arrDescription.push(`${tOrganizer}: ${organizer}\n`)
                        }
                        arrDescription.push(eventLink)

                        // Base event data.
                        const eventData: ICalEventData = {
                            id: `club-${clubEvent.id}-${evTimestamp}`,
                            start: eventDate,
                            end: endDate,
                            summary: `${clubEvent.title} ${getSportIcon(clubEvent)}`,
                            description: arrDescription.join("\n"),
                            url: eventLink
                        }

                        // Attending to the calendar and user has an email set?
                        // Add user to the list of attendees.
                        if (user.email && clubEvent.joined) {
                            eventData.attendees = [
                                {
                                    status: ICalAttendeeStatus.ACCEPTED,
                                    role: ICalAttendeeRole.OPT,
                                    type: ICalAttendeeType.INDIVIDUAL,
                                    email: user.email
                                }
                            ]
                        }

                        // Create event.
                        const event = cal.createEvent(eventData)

                        // Location available?
                        if (clubEvent.address) {
                            event.location(clubEvent.address)
                        }

                        eventCount++
                    }
                }
            }

            // Get relevant clubs (all, or filtered by ID).
            const allClubs = await strava.clubs.getClubs(user)
            const clubFilter = (c: StravaClub) => options.clubIds.includes(c.id.toString()) || (c.url && options.clubIds.includes(c.url))
            const clubs = options.clubIds?.length > 0 ? allClubs.filter(clubFilter) : allClubs

            // Iterate user's clubs to get their events and push to the calendar.
            const batchSize = user.isPro ? settings.plans.pro.apiConcurrency : settings.plans.free.apiConcurrency
            while (clubs.length) {
                await Promise.all(clubs.splice(0, batchSize).map(getEvents))
            }

            logger.debug("Calendar.buildClubs", `User ${user.id} ${user.displayName}`, optionsLog, `Got ${eventCount} club events`)
        } catch (ex) {
            logger.error("Calendar.buildClubs", `User ${user.id} ${user.displayName}`, optionsLog, ex)
        }
    }
}

// Exports...
export default Calendar.Instance
