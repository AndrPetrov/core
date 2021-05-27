// Strautomator Core: Day.js wrapper

import dayjs from "dayjs"
import dayjsAdvancedFormat from "dayjs/plugin/advancedFormat"
import dayjsLocalizedFormat from "dayjs/plugin/localizedFormat"
import dayjsUTC from "dayjs/plugin/utc"
import dayjsDayOfYear from "dayjs/plugin/dayOfYear"
import dayjsWeekYear from "dayjs/plugin/weekYear"
import dayjsDuration from "dayjs/plugin/duration"
import dayjsRelativeTime from "dayjs/plugin/relativeTime"

// Extends dayjs with required plugins.
dayjs.extend(dayjsAdvancedFormat)
dayjs.extend(dayjsLocalizedFormat)
dayjs.extend(dayjsUTC)
dayjs.extend(dayjsDayOfYear)
dayjs.extend(dayjsWeekYear)
dayjs.extend(dayjsDuration)
dayjs.extend(dayjsRelativeTime)

// Exports
export default dayjs
