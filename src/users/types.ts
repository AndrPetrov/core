// Strautomator Core: User types

import {PayPalSubscription} from "../paypal/types"
import {RecipeData} from "../recipes/types"
import {StravaProfile, StravaTokens} from "../strava/types"

/**
 * Key-value list of recipes.
 */
export interface UserRecipeMap {
    /** Recipe indexed by ID. */
    [id: string]: RecipeData
}

/**
 * User data as a JSON object, as stored on the database.
 */
export interface UserData {
    /** Unique ID, same as Strava's athlete ID. */
    id: string
    /** User's display (taken from one of the user profile fields). */
    displayName?: string
    /** User profile data from Strava. */
    profile: StravaProfile
    /** User strava access and refresh tokens. */
    stravaTokens?: StravaTokens
    /** Strava webhook ID (used for subscription / webhooks). */
    stravaWebhook?: number
    /** User email, optional. */
    email?: string
    /** List of user recipes. */
    recipes?: UserRecipeMap
    /** User preferences. */
    preferences?: UserPreferences
    /** PayPal subsccription (if subscribed to the service). */
    paypalSubscription?: PayPalSubscription
    /** Last login date (UTC). */
    dateLogin?: Date
    /** Registration date (UTC). */
    dateRegistered?: Date
    /** Next billing date (UTC). */
    dateBilling?: Date
    /** Date of last received activity from Strava. */
    dateLastActivity?: Date
    /** Recipes counter. */
    recipeCount?: number
    /** Processed activities counter. */
    activityCount?: number
}

/**
 * User preferences.
 */
export interface UserPreferences {
    /** Temperature and distance units (metric or imperial). */
    units?: "metric" | "imperial"
    /** Prefered weather provider. */
    weatherProvider?: "darksky" | "openweathermap" | "weatherbit"
}
