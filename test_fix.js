// A test script to verify what the fix looks like
const pipeline = {
  $addFields: {
    className: {
      $ifNull: [
        "$classInfo.displayName",
        {
          $concat: [
            "$classInfo.name",
            { $cond: [{ $ifNull: ["$classInfo.stream", false] }, { $concat: [" ", "$classInfo.stream"] }, ""] }
          ]
        }
      ]
    }
  }
}
console.log(pipeline);
