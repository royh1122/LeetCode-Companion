/**
 * Response shapes modeled on LeetCode's /submit/, /interpret_solution/ and
 * /submissions/detail/{id}/check/ endpoints, as used by open-source extensions
 * (LeetHub-3.0, leetcode-cli). Not captured from a live account — see
 * docs/LEETCODE_INTEGRATION.md for what was and wasn't verified.
 */
export const SUBMIT_BODY = JSON.stringify({ lang: "python3", question_id: "1", typed_code: "class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n", judge_type: "large" });
export const SUBMIT_RESPONSE = { submission_id: 1234567890 };
export const RUN_BODY = JSON.stringify({ lang: "python3", question_id: "1", typed_code: "pass", data_input: "[2,7,11,15]\n9" });
export const RUN_RESPONSE = { interpret_id: "runcode_1731100000.123456_abcd", test_case: "[2,7,11,15]\n9" };

export const CHECK_PENDING = { state: "PENDING" };
export const CHECK_STARTED = { state: "STARTED" };
export const CHECK_ACCEPTED = {
  state: "SUCCESS",
  status_code: 10,
  status_msg: "Accepted",
  lang: "python3",
  pretty_lang: "Python3",
  run_success: true,
  status_runtime: "3 ms",
  status_memory: "17.9 MB",
  total_correct: 63,
  total_testcases: 63,
  runtime_percentile: 91.2,
  memory_percentile: 40.1,
  question_id: "1",
  submission_id: "1234567890",
  task_finish_time: 1731100005123,
};
export const CHECK_WRONG = {
  state: "SUCCESS",
  status_code: 11,
  status_msg: "Wrong Answer",
  lang: "python3",
  run_success: true,
  total_correct: 12,
  total_testcases: 63,
  question_id: "1",
  last_testcase: "[3,2,4]\n6",
  expected_output: "[1,2]",
  code_output: "[0,0]",
  task_finish_time: 1731100005123,
};
export const CHECK_TLE = { state: "SUCCESS", status_code: 14, status_msg: "Time Limit Exceeded", lang: "cpp", total_correct: 50, total_testcases: 63 };
export const CHECK_CE = { state: "SUCCESS", status_code: 20, status_msg: "Compile Error", lang: "java", full_compile_error: "Line 3: error: ';' expected" };
export const CHECK_RUN_DONE = { state: "SUCCESS", status_code: 10, status_msg: "Accepted", lang: "python3", run_success: true, correct_answer: true, code_answer: ["[0,1]"] };

/** Shape of a real Wrong Answer response observed on leetcode.com at /submissions/detail/{id}/v2/check/ (ids and times replaced). */
export const CHECK_WRONG_REAL_V2 = {
  status_code: 11,
  lang: "python3",
  run_success: true,
  status_runtime: "N/A",
  memory: 19176000,
  display_runtime: "1",
  question_id: "1146",
  elapsed_time: 81,
  code_output: '"ABAB"',
  std_output: "",
  last_testcase: '"ABABAB"\n"ABAB"',
  expected_output: '"AB"',
  task_finish_time: 1700000000000,
  task_name: "judger.judgetask.Judge",
  finished: true,
  total_correct: 24,
  total_testcases: 129,
  runtime_percentile: null,
  status_memory: "N/A",
  memory_percentile: null,
  pretty_lang: "Python3",
  submission_id: "1000000001",
  input_formatted: '"ABABAB", "ABAB"',
  input: '"ABABAB"\n"ABAB"',
  status_msg: "Wrong Answer",
  state: "SUCCESS",
  judger_status_code: 11,
};

/**
 * Real request and response from leetcode.com/studyplan/top-interview-150/ (DevTools, 2026-11-10),
 * trimmed to two questions. The page loads its question list with this GraphQL call.
 */
export const STUDY_PLAN_REQUEST = JSON.stringify({
  operationName: "studyPlanDetail",
  query:
    "\n    query studyPlanDetail($slug: String!) {\n  studyPlanV2Detail(planSlug: $slug) {\n    slug\n    name\n    highlight\n    staticCoverPicture\n    colorPalette\n    threeDimensionUrl\n    description\n    premiumOnly\n    needShowTags\n    awardDescription\n    defaultLanguage\n    award {\n      name\n      config {\n        icon\n        iconGif\n        iconGifBackground\n      }\n    }\n    relatedStudyPlans {\n      cover\n      highlight\n      name\n      slug\n      premiumOnly\n    }\n    planSubGroups {\n      slug\n      name\n      premiumOnly\n      questionNum\n      questions {\n        translatedTitle\n        titleSlug\n        title\n        questionFrontendId\n        paidOnly\n        id\n        difficulty\n        hasOfficialSolution\n        topicTags {\n          slug\n          name\n        }\n        solutionInfo {\n          solutionSlug\n          solutionTopicId\n        }\n      }\n    }\n  }\n}\n    ",
  variables: { slug: "top-interview-150" },
});

/** Another GraphQL call the same page makes; must be ignored. */
export const OTHER_GRAPHQL_REQUEST = JSON.stringify({ operationName: "SurveyV2", query: "query SurveyV2($surveySlug: String!) { surveyV2(surveySlug: $surveySlug) { showSurvey } }", variables: { surveySlug: "new_study_plan_survey" } });

export const STUDY_PLAN_RESPONSE = {
  data: {
    studyPlanV2Detail: {
      slug: "top-interview-150",
      name: "Top Interview 150",
      highlight: "Example highlight",
      staticCoverPicture: "https://example.com/cover.png",
      colorPalette: "blue",
      threeDimensionUrl: "https://example.com/scene",
      description: "Example plan description\r\nSecond line",
      premiumOnly: false,
      needShowTags: false,
      awardDescription: "Example award description",
      defaultLanguage: null,
      award: { name: "Example award", config: { icon: "https://example.com/icon.png", iconGif: "https://example.com/icon.gif", iconGifBackground: "https://example.com/bg.png" } },
      relatedStudyPlans: [{ cover: "https://example.com/cover", highlight: "Example", name: "Another plan", slug: "another-plan", premiumOnly: false }],
      planSubGroups: [
        {
          slug: "top-interview-150-1-yf91",
          name: "Array / String",
          premiumOnly: false,
          questionNum: 24,
          questions: [
            { translatedTitle: null, titleSlug: "merge-sorted-array", title: "Merge Sorted Array", questionFrontendId: "88", paidOnly: false, id: "88", difficulty: "EASY", hasOfficialSolution: true, topicTags: [{ slug: "array", name: "Array" }, { slug: "two-pointers", name: "Two Pointers" }, { slug: "sorting", name: "Sorting" }], solutionInfo: null },
            { translatedTitle: null, titleSlug: "remove-element", title: "Remove Element", questionFrontendId: "27", paidOnly: false, id: "27", difficulty: "EASY", hasOfficialSolution: true, topicTags: [{ slug: "array", name: "Array" }, { slug: "two-pointers", name: "Two Pointers" }], solutionInfo: null },
          ],
        },
      ],
    },
  },
};

/**
 * Where a fully loaded study-plan page keeps the list (seen on leetcode.com/studyplan/top-interview-150/,
 * 2026-11-10): __NEXT_DATA__.props.pageProps.dehydratedState.queries.0.state.data.studyPlanV2Detail.
 * Other keys are made up; the page sends no studyPlanDetail request on a full load.
 */
export const STUDY_PLAN_NEXT_DATA = JSON.stringify({
  props: { pageProps: { dehydratedState: { queries: [{ state: { data: STUDY_PLAN_RESPONSE.data }, queryKey: ["studyPlanDetail", "top-interview-150"] }] } } },
  page: "/studyplan/[slug]",
});
