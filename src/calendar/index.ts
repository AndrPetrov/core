// Strautomator Core: Calendar

import {CachedCalendar, CalendarOptions} from "./types"
import {recipePropertyList} from "../recipes/lists"
import {UserData} from "../users/types"
import _ = require("lodash")
import crypto = require("crypto")
import database from "../database"
import eventManager from "../eventmanager"
import strava from "../strava"
import ical = require("ical-generator")
import jaul = require("jaul")
import logger = require("anyhow")
import moment = require("moment")
import url = require("url")
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
            if (!settings.calendar.cacheDuration) {
                logger.warn("Calendar.init", "No cacheDuration set, calendars output will NOT be cached")
            } else {
                const duration = moment.duration(settings.calendar.cacheDuration, "seconds").humanize()
                logger.info("Calendar.init", `Cache calendars for ${duration}`)
            }
        } catch (ex) {
            logger.error("Calendar.init", ex)
            throw ex
        }

        eventManager.on("Users.delete", this.onUserDelete)
    }

    /**
     * Delete user calendars after it gets deleted from the database.
     * @param user User that was deleted from the database.
     */
    private onUserDelete = async (user: UserData): Promise<void> => {
        try {
            const counter = await database.delete("calendar", ["userId", "==", user.id])

            if (counter > 0) {
                logger.info("Calendar.onUsersDelete", `User ${user.id} - ${user.displayName}`, `Deleted ${counter} calendars`)
            }
        } catch (ex) {
            logger.error("Calendar.onUsersDelete", `User ${user.id} - ${user.displayName}`, ex)
        }
    }

    // CALENDAR METHODS
    // --------------------------------------------------------------------------

    /**
     * Generate the Strautomator calendar and return its iCal string representation.
     * @param user The user requesting the calendar.
     * @param options Calendar generation options.
     */
    generate = async (user: UserData, options?: CalendarOptions): Promise<string> => {
        let optionsLog: string
        let cachedCalendar: CachedCalendar

        try {
            let isDefault = false

            if (!options) {
                options = {}
            }

            // Check and set default options.
            if (!options.sportTypes || options.sportTypes.length == 0) {
                options.sportTypes = null
            }
            if (!options.excludeCommutes && !options.sportTypes) {
                isDefault = true
            }
            if (!options.eventSummary || options.eventSummary == "") {
                options.eventSummary = null
            }
            if (!options.eventDetails || options.eventDetails == "") {
                options.eventDetails = null
            }

            const maxDays = user.isPro ? settings.plans.pro.maxCalendarDays : settings.plans.free.maxCalendarDays
            const minDate = moment().utc().hours(0).minutes(0).subtract(maxDays, "days")
            const dateFrom = options.dateFrom ? options.dateFrom : minDate
            const tsAfter = dateFrom.valueOf() / 1000
            const tsBefore = new Date().valueOf() / 1000

            optionsLog = `Since ${moment(dateFrom).format("YYYY-MM-DD")}, `
            optionsLog += options.sportTypes ? options.sportTypes.join(", ") : "all sports"
            if (options.excludeCommutes) optionsLog += ", exclude commutes"

            // Validation checks.
            if (minDate.isAfter(dateFrom)) {
                throw new Error(`Minimum accepted "date from" for the calendar is ${minDate.format("l")} (${maxDays} days)`)
            }

            // Use "default" if no options were passed, otherwise get a hash to fetch the correct cached calendar.
            const hash = isDefault ? "default" : crypto.createHash("sha1").update(JSON.stringify(options, null, 0)).digest("hex")
            const cacheId = `${user.id}-${hash}`
            cachedCalendar = await database.get("calendar", cacheId)

            // See if cached version of the calendar is still valid.
            // Check cached calendar expiry date (reversed / backwards) and if user has new activity since the last generated output.
            if (cachedCalendar) {
                const expiryDate = moment().utc().subtract(settings.calendar.cacheDuration, "seconds").toDate()
                const maxExpiryDate = moment().utc().subtract(settings.calendar.maxCacheDuration, "seconds").toDate()
                const updatedTs = cachedCalendar.dateUpdated.valueOf()
                const notExpired = expiryDate.valueOf() < updatedTs
                const notChanged = user.dateLastActivity && user.dateLastActivity.valueOf() < updatedTs && maxExpiryDate.valueOf() < updatedTs

                if (notExpired || notChanged) {
                    logger.info("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, "From cache")
                    return cachedCalendar.data
                }
            }

            // Set calendar name based on passed filters.
            let calName = settings.calendar.name
            if (options.sportTypes) calName += ` (${options.sportTypes.join(", ")})`

            // Prepare calendar details.
            const domain = url.parse(settings.app.url).hostname
            const prodId = {company: "Devv", product: "Strautomator", language: "EN"}
            const calUrl = `${settings.app.url}calendar/${user.urlToken}`
            const ttl = settings.calendar.ttl

            // Create ical container.
            const icalOptions: ical.CalendarData = {
                name: calName,
                domain: domain,
                prodId: prodId,
                url: calUrl,
                ttl: user.isPro ? ttl : ttl * 2
            }
            const cal = ical(icalOptions)

            // Get activities from Strava.
            const activities = await strava.activities.getActivities(user, {before: tsBefore, after: tsAfter})

            // Iterate activities from Strava, checking filters before proceeding.
            for (let a of activities) {
                if (options.sportTypes && options.sportTypes.indexOf(a.type) < 0) continue
                if (options.excludeCommutes && a.commute) continue

                const arrDetails = []

                // If no event details template was set, push default values to the details array.
                if (!options.eventDetails) {
                    if (a.commute) {
                        arrDetails.push("Commute")
                    }

                    // Iterate default fields to be added to the event details.
                    for (let f of settings.calendar.activityFields) {
                        const subDetails = []
                        const arrFields = f.split(",")

                        for (let field of arrFields) {
                            field = field.trim()

                            if (a[field]) {
                                const fieldInfo = _.find(recipePropertyList, {value: field})
                                const fieldName = fieldInfo ? fieldInfo.text : field.charAt(0).toUpperCase() + field.slice(1)
                                let suffix

                                // Get suffix for field values.
                                if (fieldInfo) {
                                    if (user.profile.units == "imperial" && fieldInfo.impSuffix) {
                                        suffix = fieldInfo.impSuffix
                                    } else if (user.profile.units == "metric" && fieldInfo.suffix) {
                                        suffix = fieldInfo.suffix
                                    }
                                }

                                // Suffix defaults to empty string.
                                if (!suffix) suffix = ""

                                subDetails.push(`${fieldName}: ${a[field]}${suffix}`)
                            }

                            arrDetails.push(subDetails.join(" - "))
                        }
                    }
                }

                // Get summary and details from options or from defaults.
                try {
                    const summaryTemplate = options.eventSummary ? options.eventSummary : settings.calendar.eventSummary
                    const summary = jaul.data.replaceTags(summaryTemplate, a)
                    const details = options.eventDetails ? jaul.data.replaceTags(options.eventDetails, a) : arrDetails.join("\n")

                    // Add activity to the calendar as an event.
                    const event = cal.createEvent({
                        uid: a.id,
                        start: a.dateStart,
                        end: a.dateEnd,
                        summary: summary,
                        description: details,
                        htmlDescription: details.replace(/\n/, "<br />"),
                        url: `https://www.strava.com/activities/${a.id}`
                    })

                    // Geo location available?
                    if (a.locationEnd) {
                        event.location(a.locationEnd.join(", "))
                        event.geo({lat: a.locationEnd[0], lon: a.locationEnd[1]})
                    }
                } catch (innerEx) {
                    logger.error("Calendar.generate", `User ${user.id} ${user.displayName}`, `Activity ${a.id}`, innerEx)
                }
            }

            // Send calendar output to the database.
            cachedCalendar = {
                id: cacheId,
                userId: user.id,
                data: cal.toString(),
                dateUpdated: moment().utc().toDate()
            }

            // Only save to database if a cacheDUration is set.
            if (settings.calendar.cacheDuration) {
                await database.set("calendar", cachedCalendar, cacheId)
            }

            logger.info("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, `${cal.events().length} events`)

            return cachedCalendar.data
        } catch (ex) {
            if (cachedCalendar && cachedCalendar.data) {
                logger.error("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, ex, "Fallback to cached calendar")
                return cachedCalendar.data
            } else {
                logger.error("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, ex)
                throw ex
            }
        }
    }
}

// Exports...
export default Calendar.Instance
