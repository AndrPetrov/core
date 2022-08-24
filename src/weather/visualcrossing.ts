// Strautomator Core: Weather - Visual Crossing

import {WeatherApiStats, WeatherProvider, WeatherSummary} from "./types"
import {getSuntimes, processWeatherSummary, weatherSummaryString} from "./utils"
import {UserPreferences} from "../users/types"
import {axiosRequest} from "../axios"
import logger = require("anyhow")
import dayjs from "../dayjs"
const settings = require("setmeup").settings

/**
 * Visual Crossing weather API.
 */
export class VisualCrossing implements WeatherProvider {
    private constructor() {}
    private static _instance: VisualCrossing
    static get Instance(): VisualCrossing {
        return this._instance || (this._instance = new this())
    }
    apiRequest = null
    stats: WeatherApiStats = null

    name: string = "visualcrossing"
    title: string = "Visual Crossing"
    hoursPast: number = 8760
    hoursFuture: number = 24

    // METHODS
    // --------------------------------------------------------------------------

    /**
     * Get current weather conditions for the specified coordinates and date.
     * @param coordinates Array with latitude and longitude.
     * @param date Date for the weather request.
     * @param preferences User preferences to get proper weather units.
     */
    getWeather = async (coordinates: [number, number], date: Date, preferences: UserPreferences): Promise<WeatherSummary> => {
        const unit = preferences && preferences.weatherUnit == "f" ? "imperial" : "metric"
        const isoDate = date.toISOString()
        const today = dayjs.utc()
        const diffHours = Math.abs(today.diff(date, "hours"))
        const isFuture = today.isBefore(date)
        const maxHours = isFuture ? this.hoursFuture : this.hoursPast

        try {
            if (diffHours > maxHours) throw new Error(`Date out of range: ${isoDate}`)
            if (!preferences) preferences = {}

            const baseUrl = settings.weather.visualcrossing.baseUrl
            const secret = settings.weather.visualcrossing.secret

            let mDate = dayjs.utc(date)
            if (mDate.dayOfYear() != dayjs.utc().dayOfYear()) {
                mDate = mDate.subtract(1, "days")
            }

            const qDate = mDate.format("YYYY-MM-DDTHH:mm:ss")
            const latlon = coordinates.join(",")
            const include = "current,obs,histfcst"
            const lang = preferences.language && preferences.language != "pt" ? preferences.language || "en" : "en"
            let weatherUrl = `${baseUrl}timeline/${latlon}/${qDate}?key=${secret}&include=${include}&unitGroup=metric&lang=${lang}`

            // Fetch weather data.
            logger.debug("VisualCrossing.getWeather", weatherUrl)
            const res = await this.apiRequest.schedule(() => axiosRequest({url: weatherUrl}))

            // Parse result.
            const result = this.toWeatherSummary(res, coordinates, date, preferences)
            if (result) {
                logger.info("VisualCrossing.getWeather", weatherSummaryString(coordinates, date, result, preferences))
            }

            return result
        } catch (ex) {
            logger.error("VisualCrossing.getWeather", coordinates, isoDate, unit, ex)
            throw ex
        }
    }

    /**
     * Transform data from the Visual Crossing API to a WeatherSummary.
     * @param data Data from Visual Crossing.
     */
    private toWeatherSummary = (data: any, coordinates: [number, number], date: Date, preferences: UserPreferences): WeatherSummary => {
        if (!data) return

        // Locate correct hour report from the response.
        if (data.days && data.days.length > 0) {
            data = data.days[0]
            if (data.hours && data.hours.length > 0) {
                data = data.hours.find((d) => d.datetime == dayjs.utc(date).format("HH:mm:ss"))
            }
        }

        // Data not found? Stop here.
        if (!data || !data.datetime) return

        // Get precipitation details.
        const precipLevel = data.precip || 0
        const snowDepth = data.snow || 0
        let precipitation = data.preciptype
        if (!precipitation) precipitation = snowDepth > 0 ? "Snow" : null
        else if (precipitation == "freezingrain" || precipitation == "ice") precipitation = "Sleet"

        const result: WeatherSummary = {
            provider: this.name,
            summary: data.conditions,
            temperature: data.temp,
            feelsLike: data.feelslike,
            humidity: data.humidity,
            pressure: data.pressure,
            windSpeed: data.windspeed ? data.windspeed / 3.6 : null,
            windDirection: data.winddir,
            precipitation: precipitation,
            cloudCover: data.cloudcover,
            visibility: data.visibility,
            extraData: {
                timeOfDay: getSuntimes(coordinates, date).timeOfDay,
                mmPrecipitation: snowDepth || precipLevel
            }
        }

        // Incomplete data returned? Discard it.
        if (result.temperature == 0 && result.humidity === null && result.pressure === null && result.windSpeed === null) {
            return
        }

        // Process and return weather summary.
        processWeatherSummary(result, date, preferences)
        return result
    }
}

// Exports...
export default VisualCrossing.Instance
