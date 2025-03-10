// Strautomator Core: Weather Utils

import {MoonPhase, Suntimes, WeatherProvider, WeatherSummary} from "./types"
import {UserPreferences} from "../users/types"
import {translation} from "../translations"
import Bottleneck from "bottleneck"
import _ from "lodash"
import logger = require("anyhow")
import dayjs from "../dayjs"

/**
 * Helper to get an API rate limiter (bottleneck) for the specified provider.
 * @param provider Weather provider object.
 * @param options Options (taken from settings).
 */
export function apiRateLimiter(provider: WeatherProvider, options: any): Bottleneck {
    const limiter = new Bottleneck({
        maxConcurrent: options.maxConcurrent,
        reservoir: options.perHour,
        reservoirRefreshAmount: options.perHour,
        reservoirRefreshInterval: 1000 * 60 * 60
    })

    // Set API request stats.
    limiter.on("queued", () => {
        const stats = provider.stats
        const newDay = stats.lastRequest && stats.lastRequest.getDate() < new Date().getDate()

        if (newDay) {
            stats.errorCount = 0
            stats.requestCount = 0
        }

        stats.requestCount++
        stats.lastRequest = new Date()
    })

    // Catch errors.
    limiter.on("error", (err) => {
        provider.stats.errorCount++
        logger.error(`Weather.${provider.name}.limiter`, err)
    })

    // Rate limiting warnings
    limiter.on("depleted", () => {
        logger.warn(`Weather.${provider.name}.limiter`, "Rate limited")
    })

    return limiter
}

/**
 * Process the passed weather summary to transformand add missing fields.
 * Numeric data passed as string will be untouched, while actual numbers
 * will be processed (converting to proper units and adding the suffixes).
 * @param summary The weather summary to be processed.
 * @param dDate The date (as a DayJS object).
 * @param preferences User preferences.
 */
export function processWeatherSummary(summary: WeatherSummary, dDate: dayjs.Dayjs, preferences: UserPreferences): void {
    const date = dDate.toDate()

    // Missing temperature and humidity? Then it's likely garbage data.
    if ((_.isNaN(summary.temperature) && _.isNaN(summary.humidity)) || (_.isNil(summary.temperature) && _.isNil(summary.humidity))) {
        throw new Error("Missing temperature and humidity")
    }

    // Default preferences.
    if (!preferences) preferences = {}

    try {
        const tempValue = parseFloat(summary.temperature.toString())
        const prcFog = translation("Fog", preferences)
        const prcDrizzle = translation("Drizzle", preferences)
        const prcRain = translation("Rain", preferences)
        const prcSleet = translation("Sleet", preferences)
        const prcSnow = translation("Snow", preferences)

        let extraData = summary.extraData || {}

        // No precipitation? Try calculating it based on the precipitation mm (if passed).
        // If no precipitation, then set it to "dry".
        if (!summary.precipitation || !_.isString(summary.precipitation)) {
            const mm = extraData.mmPrecipitation || 0

            if (mm > 0) {
                if (tempValue < 1) summary.precipitation = prcSnow
                else if (tempValue < 4) summary.precipitation = prcSleet
                else if (mm < 1) summary.precipitation = prcDrizzle
                else summary.precipitation = prcRain

                // Heavy precipitation? Append suffix.
                if (mm > 20) {
                    summary.precipitation = `${summary.precipitation} (${translation("Heavy", preferences)})`
                }
            } else {
                summary.precipitation = translation("Dry", preferences)
            }
        } else {
            summary.precipitation = translation(summary.precipitation, preferences)
        }

        summary.precipitation = summary.precipitation.toLowerCase()

        // Set missing icon text.
        if (!extraData.iconText || extraData.iconText.length < 3) {
            let lPrecipitation = summary.precipitation ? summary.precipitation.toLowerCase() : ""
            let lSummary = summary.summary ? summary.summary.toLowerCase() : ""
            let cloudCover = summary.cloudCover as any
            let iconText = "Clear"

            if (lPrecipitation == prcSnow || lSummary.includes(prcSnow)) iconText = "Snow"
            else if (lPrecipitation == prcRain || lSummary.includes(prcRain) || extraData.mmPrecipitation > 3) iconText = "Rain"
            else if (summary.visibility <= 1 || lSummary.includes(prcFog)) iconText = "Fog"
            else if (cloudCover > 70) iconText = "Cloudy"
            else if (cloudCover > 30) iconText = "MostlyCloudy"
            else if (cloudCover > 10) iconText = "MostlyClear"

            extraData.iconText = iconText
        }

        // Temperature summary.
        let tempSummary = translation("Cool", preferences)
        if (tempValue > 40) tempSummary = translation("ExtremelyWarm", preferences)
        else if (tempValue > 30) tempSummary = translation("VeryWarm", preferences)
        else if (tempValue > 22) tempSummary = translation("Warm", preferences)
        else if (tempValue < -10) tempSummary = translation("ExtremelyCold", preferences)
        else if (tempValue < 2) tempSummary = translation("VeryCold", preferences)
        else if (tempValue < 12) tempSummary = translation("Cold", preferences)

        // Make sure the "feels like" temperature is set.
        if (_.isNil(summary.feelsLike)) {
            summary.feelsLike = summary.temperature
        }

        // Temperature.
        const tempUnit = preferences.weatherUnit == "f" ? "F" : "C"
        if (preferences.weatherUnit == "f") {
            summary.feelsLike = celsiusToFahrenheit(summary.feelsLike as number)
            summary.temperature = celsiusToFahrenheit(summary.temperature as number)
        }
        summary.feelsLike = `${Math.round(summary.feelsLike as number)}°${tempUnit}`
        summary.temperature = `${Math.round(summary.temperature as number)}°${tempUnit}`

        // Humidity.
        if (!_.isNil(summary.humidity)) {
            summary.humidity = `${Math.round(summary.humidity as number)}%`
        }

        // Pressure.
        if (!_.isNil(summary.pressure)) {
            summary.pressure = `${Math.round(summary.pressure as number)} hPa`
        }

        // Wind summary.
        const isWindy = summary.windSpeed && (summary.windSpeed as number) > 20

        // Wind speed.
        if (!_.isNil(summary.windSpeed)) {
            const windUnit = preferences.windSpeedUnit ? preferences.windSpeedUnit : preferences.weatherUnit == "f" ? "mph" : "kph"
            const windSpeed = windUnit == "m/s" ? summary.windSpeed : windUnit == "mph" ? msToMph(summary.windSpeed as number) : msToKph(summary.windSpeed as number)
            summary.windSpeed = `${Math.round(windSpeed as number)} ${windUnit}`
        }

        // Wind direction.
        if (!_.isNil(summary.windDirection)) {
            summary.windDirection = degToDirection(summary.windDirection as number)
        }

        // Cloud coverage.
        if (!_.isNil(summary.cloudCover)) {
            summary.cloudCover = `${(summary.cloudCover as number).toFixed(0)}%`
        }

        // Set moon phase.
        summary.moon = getMoonPhase(date)

        // Select correct weather icon. Defaults to cloudy.
        let unicodeIcon: string = "2601"
        switch (extraData.iconText) {
            case "Clear":
                if (extraData.timeOfDay == "day") {
                    unicodeIcon = "2600"
                } else if (summary.moon == MoonPhase.Full) {
                    unicodeIcon = "1F316"
                } else {
                    unicodeIcon = "1F312"
                }
                break
            case "MostlyClear":
                unicodeIcon = "1F324"
                break
            case "MostlyCloudy":
                if (extraData.timeOfDay == "day") {
                    unicodeIcon = "26C5"
                } else {
                    unicodeIcon = "1F319"
                }
                break
            case "Drizzle":
            case "Rain":
                unicodeIcon = "1F327"
                break
            case "Snow":
                unicodeIcon = "2744"
                break
            case "Sleet":
                unicodeIcon = "1F328"
                break
            case "Wind":
            case "Windy":
                unicodeIcon = "1F32C"
                break
            case "Fog":
                unicodeIcon = "1F32B"
                break
            case "Thunderstorm":
                unicodeIcon = "26C8"
                break
            case "Tornado":
            case "Hurricane":
                unicodeIcon = "1F32A"
                break
        }

        // Convert code to unicode emoji.
        if (unicodeIcon) {
            summary.icon = String.fromCodePoint(parseInt(unicodeIcon, 16))
        }

        // Air quality index.
        if (!_.isNil(summary.aqi)) {
            let aqiIcon = "1F7E2"
            switch (summary.aqi) {
                case 1:
                    aqiIcon = "1F7E1"
                    break
                case 2:
                    aqiIcon = "1F7E0"
                    break
                case 3:
                    aqiIcon = "1F534"
                    break
                case 4:
                    aqiIcon = "1F7E3"
                    break
                case 5:
                    aqiIcon = "1F7E4"
            }

            summary.aqiIcon = String.fromCodePoint(parseInt(aqiIcon, 16))
        }

        // Summary set? Check if it has a translation. If unset, set one now.
        if (summary.summary) {
            summary.summary = translation(summary.summary, preferences)
        } else {
            summary.summary = `${tempSummary}, ${translation(extraData.iconText, preferences)}`
            if (isWindy) summary.summary += `, ${translation("Windy", preferences)}`
        }

        // Final trimmed summary should be always Capital cased.
        summary.summary = (summary.summary.charAt(0).toUpperCase() + summary.summary.slice(1)).trim()

        // Extra data not needed any longer.
        delete summary.extraData
    } catch (ex) {
        delete summary.extraData
        const weatherProps = Object.keys(summary).map((key) => `${key}: ${summary[key]}`)
        logger.error("Weather.processWeatherSummary", dDate.format("lll"), weatherProps.join(" | "), ex)
    }
}

/**
 * Helper to get a single liner with the summary of a weather summary.
 * @param coordinates Coordinates.
 * @param dDate The date (as a DayJS object).
 * @param summary The parsed weather summary.
 */
export function weatherSummaryString(coordinates: [number, number], dDate: dayjs.Dayjs, summary: WeatherSummary): string {
    const dateFormat = dDate.format("lll")
    const weatherProps = Object.keys(summary).map((key) => (!["provider", "icon", "summary"].includes(key) ? `${key}: ${summary[key]}` : summary[key]))
    return `${coordinates.join(", ")} | ${dateFormat} | ${summary.icon} ${summary.summary} | ${weatherProps.join(", ")}`
}

/**
 * Get the moon phase for the specified date.
 * @param date Date to get the moon phase for.
 */
export function getMoonPhase(date: Date): MoonPhase {
    let year = date.getFullYear()
    let month = date.getMonth() + 1
    let day = date.getDate()
    let zone = date.getTimezoneOffset() / 1440
    let phase

    if (month < 3) {
        year--
        month += 12
    }

    let c = 365.25 * year
    let e = 30.6 * month

    // Get total elapsed days and divide by moon cycle.
    let jd = c + e + day + zone - 694039.09
    jd /= 29.5305882

    // Get only the integer part of the result and leave fractional part out.
    phase = parseInt(jd.toString())
    jd -= phase

    // Here's the actual moon phase. From 0 (new moon) to 4 (full moon) to 7 (waning crescent).
    phase = Math.round(jd * 8)
    if (phase >= 8) phase = 0

    // Return  moon phase.
    if (phase == 0) return MoonPhase.New
    if (phase == 4) return MoonPhase.Full
    return MoonPhase.Quarter
}

/**
 * Get the sunrise and sunset on the specified coordinates / date.
 * @param coordinates Latitude and longitude.
 * @param dDate The date (as a DayJS object).
 */
export function getSuntimes(coordinates: [number, number], dDate: dayjs.Dayjs): Suntimes {
    const date = dDate.toDate()
    const lat = coordinates[0]
    const lng = coordinates[1]
    const radians = Math.PI / 180.0
    const degrees = 180.0 / Math.PI

    // Based on https://gist.github.com/ruiokada/b28076d4911820ddcbbc
    const a = Math.floor((14 - (date.getMonth() + 1.0)) / 12)
    const y = date.getFullYear() + 4800 - a
    const m = date.getMonth() + 1 + 12 * a - 3
    const jDay = date.getDate() + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045
    const nStar = jDay - 2451545.0009 - lng / 360.0
    const n = Math.floor(nStar + 0.5)
    const solarNoon = 2451545.0009 - lng / 360.0 + n
    const M = 356.047 + 0.9856002585 * n
    const C = 1.9148 * Math.sin(M * radians) + 0.02 * Math.sin(2 * M * radians) + 0.0003 * Math.sin(3 * M * radians)
    const L = (M + 102.9372 + C + 180) % 360
    const jTransit = solarNoon + 0.0053 * Math.sin(M * radians) - 0.0069 * Math.sin(2 * L * radians)
    const D = Math.asin(Math.sin(L * radians) * Math.sin(23.45 * radians)) * degrees
    const cosOmega = (Math.sin(-0.83 * radians) - Math.sin(lat * radians) * Math.sin(D * radians)) / (Math.cos(lat * radians) * Math.cos(D * radians))

    // Sun never rises or never sets.
    if (cosOmega > 1) return {timeOfDay: "night"}
    if (cosOmega < -1) return {timeOfDay: "day"}

    // Get Julian dates of sunrise/sunset.
    const omega = Math.acos(cosOmega) * degrees
    const jRise = jTransit - omega / 360.0
    const jSet = jTransit + omega / 360.0

    // Calculate it.
    const utcRise = 24 * (jRise - jDay) + 12
    const utcSet = 24 * (jSet - jDay) + 12
    const localRise = (utcRise + dDate.utcOffset() / 60) % 24
    const localSet = (utcSet + dDate.utcOffset() / 60) % 24

    let hourSunrise: any = Math.floor(localRise)
    let minuteSunrise: any = Math.round((localRise - Math.floor(localRise)) * 60)
    let hourSunset: any = Math.floor(localSet)
    let minuteSunset: any = Math.round((localSet - Math.floor(localSet)) * 60)
    if (hourSunrise < 10) hourSunrise = `0${hourSunrise}`
    if (minuteSunrise < 10) minuteSunrise = `0${minuteSunrise}`
    if (hourSunset < 10) hourSunset = `0${hourSunset}`
    if (minuteSunset < 10) minuteSunset = `0${minuteSunset}`

    const sunrise = `${hourSunrise}:${minuteSunrise}`
    const sunset = `${hourSunset}:${minuteSunset}`
    const fDate = dDate.format("HH:mm")
    const timeOfDay = fDate >= sunrise && fDate <= sunset ? "day" : "night"
    const suntimesResult: Suntimes = {sunrise: sunrise, sunset: sunset, timeOfDay: timeOfDay}

    logger.debug("Weather.getSuntimes", dDate.format("lll"), suntimesResult)

    return suntimesResult
}

/**
 * Convert Celsius to Fahrenheit.
 * @param celsius Temperature in celsius.
 */
export function celsiusToFahrenheit(celsius: number): number {
    return Math.round((celsius * 9) / 5 + 32)
}

/**
 * Convert meters / second to kph.
 * @param ms Meters per second.
 */
export function msToKph(ms: number): number {
    return Math.round(ms * 3.6)
}

/**
 * Convert meters / second to kph.
 * @param ms Meters per second.
 */
export function msToMph(ms: number): number {
    return Math.round(ms * 2.24)
}

/**
 * Converts bearing (degrees) to a text direction.
 * @param deg Bearing value from 0 to 359.
 */
export function degToDirection(deg: number): string {
    const value = Math.floor(deg / 22.5 + 0.5)
    const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return directions[value % 16]
}
