package handlers

import (
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/panarastudios/panara-cloud/apps/monitoring/database"
	"github.com/panarastudios/panara-cloud/apps/monitoring/monitoring"
)

// A moment given as Unix seconds (a decimal fraction is allowed) or as an
// RFC 3339 timestamp.
func parseMoment(value string) (time.Time, bool) {
	if secs, err := strconv.ParseFloat(value, 64); err == nil {
		if math.IsNaN(secs) || math.IsInf(secs, 0) || math.Abs(secs) > 1e11 {
			return time.Time{}, false
		}
		whole, fraction := math.Modf(secs)
		return time.Unix(int64(whole), int64(math.Round(fraction*1e9))).UTC(), true
	}
	if at, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return at.UTC(), true
	}
	return time.Time{}, false
}

func badRequest(c *fiber.Ctx, message string) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": message})
}

func bucketedMetrics(c *fiber.Ctx, db *database.DB) error {
	from, ok := parseMoment(c.Query("from"))
	if !ok {
		return badRequest(c, "from must be Unix seconds or an RFC 3339 time")
	}
	to, ok := parseMoment(c.Query("to"))
	if !ok {
		return badRequest(c, "to must be Unix seconds or an RFC 3339 time")
	}
	stepSeconds, err := strconv.ParseInt(c.Query("step"), 10, 64)
	if err != nil || stepSeconds < 1 || stepSeconds > 366*86400 {
		return badRequest(c, "step must be a whole number of seconds")
	}
	metrics, err := db.GetBucketedMetrics(from, to, time.Duration(stepSeconds)*time.Second)
	switch {
	case errors.Is(err, database.ErrInvalidRange),
		errors.Is(err, database.ErrInvalidStep),
		errors.Is(err, database.ErrTooManyBuckets):
		return badRequest(c, err.Error())
	case err != nil:
		return c.Status(500).JSON(fiber.Map{"error": "Failed to fetch metrics"})
	}
	return c.JSON(metrics)
}

// ServerMetrics answers GET /metrics in one of two shapes.
//
// With `from`, `to` and `step` (seconds): one object, the readings of that
// range summarised per bucket (see database.BucketedMetrics). A `limit` sent
// along is ignored, so a caller that does not know whether the collector
// understands ranges can send both and tell by the shape of the answer.
//
// Otherwise, as every release has answered: an array of the last `limit`
// readings (default 50, or "all"), oldest first.
func ServerMetrics(db *database.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if c.Query("from") != "" || c.Query("to") != "" || c.Query("step") != "" {
			return bucketedMetrics(c, db)
		}

		limit := c.Query("limit", "50")

		var metrics []monitoring.SystemMetrics
		if limit == "all" {
			dbMetrics, err := db.GetAllMetrics()
			if err != nil {
				return c.Status(500).JSON(fiber.Map{
					"error": "Failed to fetch metrics",
				})
			}
			for _, m := range dbMetrics {
				metrics = append(metrics, monitoring.ConvertToSystemMetrics(m))
			}
		} else {
			n, err := strconv.Atoi(limit)
			if err != nil {
				n = 50
			}
			dbMetrics, err := db.GetLastNMetrics(n)
			if err != nil {
				return c.Status(500).JSON(fiber.Map{
					"error": "Failed to fetch metrics",
				})
			}
			for _, m := range dbMetrics {
				metrics = append(metrics, monitoring.ConvertToSystemMetrics(m))
			}
		}

		return c.JSON(metrics)
	}
}
