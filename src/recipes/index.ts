// Strautomator Core: Recipe

import {recipePropertyList, recipeActionList} from "./lists"
import {RecipeAction, RecipeActionType, RecipeCondition, RecipeData, RecipeOperator} from "./types"
import {StravaActivity} from "../strava/types"
import {UserData} from "../users/types"
import database from "../database"
import weather from "../weather"
import _ = require("lodash")
import jaul = require("jaul")
import logger = require("anyhow")
import moment = require("moment")
const settings = require("setmeup").settings

/**
 * Evaluate and process automation recipes.
 */
export class Recipes {
    private constructor() {}
    private static _instance: Recipes
    static get Instance() {
        return this._instance || (this._instance = new this())
    }

    /**
     * List of possible property names for conditions.
     */
    get propertyList() {
        return recipePropertyList
    }

    /**
     * List of possible recipe actions.
     */
    get actionList() {
        return recipeActionList
    }

    // PROCESSING
    // --------------------------------------------------------------------------

    /**
     * Validate a recipe, mostly called before saving to the database.
     * Will throw an error when something wrong is found.
     * @param recipe The recipe object.
     */
    validate = (recipe: RecipeData): void => {
        try {
            if (!recipe.title) {
                throw new Error("Missing recipe title")
            }

            if (recipe.title.length > settings.recipes.maxLength.title) {
                throw new Error(`Recipe title is too long (max length is ${settings.recipes.maxLength.title})`)
            }

            if (!recipe.conditions || !_.isArray(recipe.conditions) || recipe.conditions.length < 0) {
                throw new Error("Missing recipe conditions")
            }

            if (!recipe.actions || !_.isArray(recipe.actions) || recipe.actions.length < 0) {
                throw new Error("Missing recipe actions")
            }

            // Parse recipe conditions.
            for (let condition of recipe.conditions) {
                if (!condition.property) {
                    throw new Error(`Missing condition property`)
                }
                if (!Object.values(RecipeOperator).includes(condition.operator)) {
                    throw new Error(`Invalid condition operator: ${condition.operator}`)
                }
                if (condition.value === null || condition.value === "") {
                    throw new Error(`Missing condition value`)
                }
                if (_.isString(condition.value) && (condition.value as string).length > settings.recipes.maxLength.conditionValue) {
                    throw new Error(`Condition value is too long (max length is ${settings.recipes.maxLength.conditionValue})`)
                }
                if (condition.friendlyValue && _.isString(condition.friendlyValue) && (condition.friendlyValue as string).length > settings.recipes.maxLength.conditionValue) {
                    throw new Error(`Condition friendly value is too long (max length is ${settings.recipes.maxLength.conditionValue})`)
                }

                // Check for non-schema fields.
                const keys = Object.keys(condition)
                for (let key of keys) {
                    if (["property", "operator", "value", "friendlyValue"].indexOf(key) < 0) {
                        throw new Error(`Invalid field: ${key}`)
                    }
                }
            }

            // Parse recipe actions.
            for (let action of recipe.actions) {
                if (!Object.values(RecipeActionType).includes(action.type)) {
                    throw new Error(`Invalid action type: ${action.type}`)
                }
                if (action.type != RecipeActionType.Commute) {
                    if (action.value === null || action.value === "") {
                        throw new Error(`Missing action value`)
                    }
                }
                if (action.value && _.isString(action.value) && (action.value as string).length > settings.recipes.maxLength.actionValue) {
                    throw new Error(`Action value is too long (max length is ${settings.recipes.maxLength.actionValue})`)
                }

                // Check for non-schema fields.
                const keys = Object.keys(action)
                for (let key of keys) {
                    if (["type", "value", "friendlyValue"].indexOf(key) < 0) {
                        throw new Error(`Invalid field: ${key}`)
                    }
                }
            }
        } catch (ex) {
            logger.error("Recipes.validate", JSON.stringify(recipe, null, 0), ex)
            throw ex
        }
    }

    /**
     * Evaluate the activity against the defined conditions and actions,
     * and return the updated Strava activity.
     * @param user The recipe's owner.
     * @param id The recipe ID.
     * @param activity Strava activity to be evaluated.
     */
    evaluate = async (user: UserData, id: string, activity: StravaActivity): Promise<boolean> => {
        const recipe: RecipeData = user.recipes[id]

        if (!recipe) {
            throw new Error(`Recipe ${id} not found`)
        }

        // Iterate conditions.
        for (let c of recipe.conditions) {
            try {
                const prop = c.property.toLowerCase()

                // Location condition.
                if (prop.indexOf("location") >= 0) {
                    if (!this.checkLocation(activity, c)) {
                        return false
                    }
                }

                // Date and time condition.
                else if (prop.indexOf("date") >= 0) {
                    if (!this.checkTimestamp(activity, c)) {
                        return false
                    }
                }

                // Number condition.
                else if (_.isNumber(activity[c.property])) {
                    if (!this.checkNumber(activity, c)) {
                        return false
                    }
                }

                // Text condition.
                else {
                    if (!this.checkText(activity, c)) {
                        return false
                    }
                }
            } catch (ex) {
                logger.error("Recipes.evaluate", `User ${user.id}`, `Activity ${activity.id}`, Object.values(c).join(", "), ex)
                return false
            }
        }

        // Iterate and execute actions.
        for (let action of recipe.actions) {
            await this.processAction(user, activity, action)
        }

        // Increase its counter on the database.

        return true
    }

    /**
     * Process a value string against an activity and return the final result.
     * @param activity A Strava activity.
     * @param value The value string template.
     */
    processAction = async (user: UserData, activity: StravaActivity, action: RecipeAction): Promise<void> => {
        logger.debug("Recipes.processAction", activity, action)

        // Mark activity as commute?
        if (action.type == RecipeActionType.Commute) {
            activity.commute = true
            return
        }

        // Change activity gear?
        if (action.type == RecipeActionType.Gear) {
            let gear = _.find(user.profile.bikes, {id: action.value})
            if (!gear) {
                gear = _.find(user.profile.shoes, {id: action.value})
            }
            if (!gear) {
                this.reportInvalidAction(user, action, "Gear not found")
            } else {
                activity.gear = gear
            }
            return
        }

        let processedValue = action.value

        // Iterate activity properties and replace keywords set on the action value.
        processedValue = jaul.data.replaceTags(processedValue, activity)

        // Weather tags on the value? Fetch weather and process it.
        if (processedValue.indexOf("${weather.") >= 0) {
            const weatherDetails = await weather.getActivityWeather(activity)
            processedValue = jaul.data.replaceTags(processedValue, weatherDetails, "weather.")
        }

        // Change activity name?
        if (action.type == RecipeActionType.Name) {
            activity.name = processedValue
            return
        }

        // Change activity description?
        if (action.type == RecipeActionType.Description) {
            activity.description = processedValue
            return
        }
    }

    /**
     * String representation of the recipe.
     * @recipe The recipe to get the summary for.
     */
    getSummary = (recipe: RecipeData): string => {
        const result = []

        for (let condition of recipe.conditions) {
            result.push(`${condition.property} ${condition.operator} ${condition.value}`)
        }

        for (let action of recipe.actions) {
            result.push(`${action.type}: ${action.value}`)
        }

        return result.join(", ")
    }

    /**
     * Increment a recipe's trigger count.
     * @param user The user to have activity count incremented.
     * @param id The recipe ID.
     */
    setTriggerCount = async (user: UserData, id: string): Promise<void> => {
        try {
            await database.increment("users", user.id, `recipes.${id}.triggerCount`)
        } catch (ex) {
            logger.error("Recipes.setTriggerCount", `User ${user.id} - ${user.profile.username}`, `Recipe ${id}`, ex)
        }
    }

    // HELPERS
    // --------------------------------------------------------------------------

    /**
     * Check if the passed location based condition is valid.
     * @param activity The Strava activity to be checked.
     * @param condition The location based recipe condition.
     */
    private checkLocation = (activity: StravaActivity, condition: RecipeCondition): boolean => {
        const prop = condition.property
        const op = condition.operator

        // Parse condition and activity's coordinates.
        const arr = condition.value.toString().split(",")
        const cLat = parseFloat(arr[0])
        const cLong = parseFloat(arr[1])
        const activityLat = activity[prop][0]
        const activityLong = activity[prop][0]
        let radius

        // When using "equals" use around 40m radius, and "like" use 500m radius.
        if (op == RecipeOperator.Equal) {
            radius = 0.00037
        } else if (op == RecipeOperator.Like) {
            radius = 0.00458
        } else {
            throw new Error(`Invalid operator ${op} for ${prop}`)
        }

        // Check if activity start / end location matches the one defined on the condition.
        const valid = activityLat < cLat + radius && activityLat > cLat - radius && activityLong < cLong + radius && activityLong > cLong - radius

        if (!valid) {
            logger.debug("Recipes.checkLocation", `Activity ${activity.id}`, condition, `Failed`)
        }

        return valid
    }

    /**
     * Check if the passed date time based condition is valid.
     * @param activity The Strava activity to be checked.
     * @param condition The date time based recipe condition.
     */
    private checkTimestamp = (activity: StravaActivity, condition: RecipeCondition): boolean => {
        const prop = condition.property
        const op = condition.operator

        // Parse condition and activity's date.
        const value = parseFloat(condition.value as string)
        const aTime = parseFloat(moment(activity[prop]).format("Hmm"))
        let valid: boolean = true

        // Check it time is greater, less or around 15min of the condition's time.
        if (op == RecipeOperator.GreaterThan) {
            valid = value > aTime
        } else if (op == RecipeOperator.LessThan) {
            valid = value < aTime
        } else if (op == RecipeOperator.Like) {
            valid = value >= aTime - 20 && value <= aTime + 20
        } else if (op == RecipeOperator.Equal) {
            valid = value >= aTime - 1 && value <= aTime + 1
        } else {
            throw new Error(`Invalid operator ${op} for ${prop}`)
        }

        if (!valid) {
            logger.debug("Recipes.checkTimestamp", `Activity ${activity.id}`, condition, `Failed`)
        }

        return valid
    }

    /**
     * Check if the passed number based condition is valid.
     * @param activity The Strava activity to be checked.
     * @param condition The number based recipe condition.
     */
    private checkNumber = (activity: StravaActivity, condition: RecipeCondition): boolean => {
        const prop = condition.property
        const op = condition.operator

        const value = condition.value
        const aNumber = activity[prop]
        let valid: boolean = true

        if (op == RecipeOperator.Equal && aNumber != value) {
            valid = false
        } else if (op == RecipeOperator.GreaterThan && aNumber <= value) {
            valid = false
        } else if (op == RecipeOperator.LessThan && aNumber >= value) {
            valid = false
        } else {
            throw new Error(`Invalid operator ${op} for ${prop}`)
        }

        if (!valid) {
            logger.debug("Recipes.checkNumber", `Activity ${activity.id}`, condition, `Failed`)
        }

        return valid
    }

    /**
     * Check if the passed text / string based condition is valid.
     * @param activity The Strava activity to be checked.
     * @param condition The text / string based recipe condition.
     */
    private checkText = (activity: StravaActivity, condition: RecipeCondition): boolean => {
        const prop = condition.property
        const op = condition.operator

        // Parse condition and activity's lowercased values.
        const value = condition.value.toString().toLowerCase()
        const aText = activity[prop].toString().toLowerCase()
        let valid: boolean = true

        if (op == RecipeOperator.Equal && aText != value) {
            valid = false
        } else if (op == RecipeOperator.Like && aText.indexOf(value) < 0) {
            valid = false
        } else {
            throw new Error(`Invalid operator ${op} for ${prop}`)
        }

        if (!valid) {
            logger.debug("Recipes.checkText", `Activity ${activity.id}`, condition, `Failed`)
        }

        return valid
    }

    /**
     * Alert when a specific action has invalid parameters.
     * @param user The recipe's owner.
     * @param action The action with an invalid parameter.
     */
    reportInvalidAction = (user: UserData, action: RecipeAction, message?: string) => {
        logger.warn("Recipes.reportInvalidAction", `User ${user.id} - ${user.profile.username}`, `Action ${action.type}: ${action.value}`, message)
    }
}

// Exports...
export default Recipes.Instance
