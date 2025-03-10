// Strautomator Core: Recipe types

import {StravaSport} from "../strava/types"

/**
 * User's recipe definition.
 */
export interface RecipeData {
    /** Recipe unique ID (inside a user object). */
    id: string
    /** Title or short description. */
    title: string
    /** List of conditions to be evaluated. */
    conditions: RecipeCondition[]
    /** List of actions to be executed. */
    actions: RecipeAction[]
    /** Order of execution (1 executes first, then 2, 3...) */
    order?: number
    /** Conditions should use AND or OR as its logical operator? */
    op?: "OR" | "AND"
    /** Same type (grouped) conditions should use AND or OR as its logical operator? */
    samePropertyOp?: "OR" | "AND"
    /** Default recipe for a specific sport (applies to all incoming activities). */
    defaultFor?: StravaSport
    /** Stop executing other automations if this one executes. */
    killSwitch?: boolean
    /** Is the recipe disabled? */
    disabled?: boolean
}

/**
 * A recipe action to be executed on a Strava activity.
 */
export interface RecipeAction {
    /** Type of action. */
    type: RecipeActionType
    /** Target action value. */
    value: any
    /** Friendly display value. */
    friendlyValue?: string
}

/**
 * A recipe condition with property, operator and target value.
 */
export interface RecipeCondition {
    /** Name of activity property. */
    property: string
    /** Operator. */
    operator: RecipeOperator
    /** Target value. */
    value: boolean | string | number
    /** Friendly display value. */
    friendlyValue?: string
}

/**
 * Recipe stats saved on the database.
 */
export interface RecipeStatsData {
    /** The ID is on the format of UserID-RecipeID. */
    id: string
    /** User that owns this recipe. */
    userId: string
    /** When was it last triggered. */
    dateLastTrigger?: Date
    /** List of activity IDs that triggered the recipe. */
    activities: number[]
    /** Total number of activities processed by the recipe. */
    activityCount?: number
    /** Custom counter that can be used on activity name and description. */
    counter?: number
    /** Failed execution counter (gets reset if recipe executes sucessfully). */
    recentFailures?: number
    /** Recipe stats archived? */
    archived?: boolean
}

/**
 * Helper interface used for music tags.
 */
export interface RecipeMusicTags {
    /** Full track list for the activity. */
    trackList: string
    /** Music track on the start of an activity. */
    trackStart: string
    /** Music track on the end of an activity. */
    trackEnd: string
    /** Lyrics for the track on the start of an activity. */
    lyricsStart?: string
    /** Lyrics for the track on the end of an activity. */
    lyricsEnd?: string
}

/**
 * Types of recipe actions.
 */
export enum RecipeActionType {
    Commute = "commute",
    Name = "name",
    PrependName = "prependName",
    AppendName = "appendName",
    GenerateName = "generateName",
    Description = "description",
    PrependDescription = "prependDescription",
    AppendDescription = "appendDescription",
    Gear = "gear",
    HideHome = "hideHome",
    HideStatPace = "hideStatPace",
    HideStatSpeed = "hideStatSpeed",
    HideStatCalories = "hideStatCalories",
    HideStatHeartRate = "hideStatHeartRate",
    HideStatPower = "hideStatPower",
    SportType = "sportType",
    WorkoutType = "workoutType",
    PrivateNote = "privateNote",
    MapStyle = "mapStyle",
    Webhook = "webhook"
}

/**
 * Types of recipe operators.
 */
export enum RecipeOperator {
    Equal = "=",
    NotEqual = "!=",
    Like = "like",
    NotLike = "notlike",
    Approximate = "approx",
    GreaterThan = ">",
    LessThan = "<"
}
