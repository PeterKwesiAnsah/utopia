import React from 'react'
import { MetadataUtils } from '../../../../core/model/element-metadata-utils'
import { last, uniqBy } from '../../../../core/shared/array-utils'
import { ElementInstanceMetadataMap } from '../../../../core/shared/element-template'
import {
  boundingRectangleArray,
  CanvasPoint,
  distance,
  point,
  WindowPoint,
  windowPoint,
} from '../../../../core/shared/math-utils'
import { ElementPath } from '../../../../core/shared/project-file-types'
import * as EP from '../../../../core/shared/element-path'
import { fastForEach, NO_OP } from '../../../../core/shared/utils'
import { KeysPressed } from '../../../../utils/keyboard'
import { useKeepShallowReferenceEquality } from '../../../../utils/react-performance'
import Utils from '../../../../utils/utils'
import {
  clearHighlightedViews,
  clearSelection,
  selectComponents,
  setFocusedElement,
  setHighlightedView,
} from '../../../editor/actions/action-creators'
import { EditorState } from '../../../editor/store/editor-state'
import { useEditorState, useRefEditorState } from '../../../editor/store/store-hook'
import CanvasActions from '../../canvas-actions'
import { DragState, moveDragState } from '../../canvas-types'
import {
  createDuplicationNewUIDs,
  getDragStateDrag,
  getOriginalCanvasFrames,
} from '../../canvas-utils'
import {
  findFirstParentWithValidElementPath,
  getAllTargetsAtPoint,
  getValidTargetAtPoint,
} from '../../dom-lookup'
import { useWindowToCanvasCoordinates } from '../../dom-lookup-hooks'
import { useInsertModeSelectAndHover } from './insert-mode-hooks'
import { WindowMousePositionRaw } from '../../../../utils/global-positions'
import { isFeatureEnabled } from '../../../../utils/feature-switches'
import { createInteractionViaMouse } from '../../canvas-strategies/interaction-state'
import { Modifier } from '../../../../utils/modifiers'
import { pathsEqual } from '../../../../core/shared/element-path'

const DRAG_START_TRESHOLD = 2

export function isResizing(editorState: EditorState): boolean {
  // TODO retire isResizing and replace with isInteractionActive once we have the strategies turned on, and the old controls removed
  const dragState = editorState.canvas.dragState
  return (
    (dragState?.type === 'RESIZE_DRAG_STATE' &&
      getDragStateDrag(dragState, editorState.canvas.resizeOptions) != null) ||
    editorState.canvas.interactionSession != null
  )
}

export function isDragging(editorState: EditorState): boolean {
  // TODO retire isDragging and replace with isInteractionActive once we have the strategies turned on, and the old controls removed
  const dragState = editorState.canvas.dragState
  return (
    (dragState?.type === 'MOVE_DRAG_STATE' &&
      getDragStateDrag(dragState, editorState.canvas.resizeOptions) != null) ||
    editorState.canvas.interactionSession != null
  )
}

export function isInserting(editorState: EditorState): boolean {
  const dragState = editorState.canvas.dragState
  return (
    dragState?.type === 'INSERT_DRAG_STATE' &&
    getDragStateDrag(dragState, editorState.canvas.resizeOptions) != null
  )
}

export function pickSelectionEnabled(
  canvas: EditorState['canvas'],
  keysPressed: KeysPressed,
): boolean {
  return canvas.selectionControlsVisible && !keysPressed['z'] && canvas.textEditor == null
}

/**
 * maybeHighlightOnHover and maybeClearHighlightsOnHoverEnd are moved here from new-canvas-controls, kept as-is for continuity
 */
export function useMaybeHighlightElement(): {
  maybeHighlightOnHover: (target: ElementPath) => void
  maybeClearHighlightsOnHoverEnd: () => void
} {
  const stateRef = useRefEditorState((store) => {
    return {
      dispatch: store.dispatch,
      resizing: isResizing(store.editor),
      dragging: isDragging(store.editor),
      selectionEnabled: pickSelectionEnabled(store.editor.canvas, store.editor.keysPressed),
      inserting: isInserting(store.editor),
      highlightedViews: store.editor.highlightedViews,
    }
  })

  const maybeHighlightOnHover = React.useCallback(
    (target: ElementPath): void => {
      /// target, parts, array, 0 contains [0: "0cd" 1: "478]
      const {
        dispatch,
        dragging,
        resizing,
        selectionEnabled,
        inserting,
        highlightedViews,
      } = stateRef.current

      const alreadyHighlighted = pathsEqual(target, highlightedViews?.[0])

      if (selectionEnabled && !dragging && !resizing && !inserting && !alreadyHighlighted) {
        dispatch([setHighlightedView(target)], 'canvas')
      }
    },
    [stateRef],
  )

  const maybeClearHighlightsOnHoverEnd = React.useCallback((): void => {
    const { dispatch, dragging, resizing, selectionEnabled } = stateRef.current
    if (selectionEnabled && !dragging && !resizing) {
      dispatch([clearHighlightedViews()], 'canvas')
    }
  }, [stateRef])

  return {
    maybeHighlightOnHover: maybeHighlightOnHover,
    maybeClearHighlightsOnHoverEnd: maybeClearHighlightsOnHoverEnd,
  }
}

function filterHiddenInstances(
  hiddenInstances: Array<ElementPath>,
  paths: Array<ElementPath>,
): Array<ElementPath> {
  return paths.filter((path) => hiddenInstances.every((hidden) => !EP.pathsEqual(path, hidden)))
}

export function getSelectableViews(
  componentMetadata: ElementInstanceMetadataMap,
  selectedViews: Array<ElementPath>,
  hiddenInstances: Array<ElementPath>,
  allElementsDirectlySelectable: boolean,
  childrenSelectable: boolean,
): ElementPath[] {
  let candidateViews: Array<ElementPath>

  if (allElementsDirectlySelectable) {
    candidateViews = MetadataUtils.getAllPathsIncludingUnfurledFocusedComponents(componentMetadata)
  } else {
    const scenes = MetadataUtils.getAllStoryboardChildrenPaths(componentMetadata)
    let rootElementsToFilter: ElementPath[] = []
    let dynamicScenesWithFragmentRootViews: ElementPath[] = []
    Utils.fastForEach(scenes, (path) => {
      const scene = MetadataUtils.findElementByElementPath(componentMetadata, path)
      const rootElements = MetadataUtils.getRootViewPaths(componentMetadata, path)
      if (
        MetadataUtils.isSceneTreatedAsGroup(scene) &&
        rootElements != null &&
        rootElements.length > 1
      ) {
        rootElementsToFilter.push(...rootElements)
        dynamicScenesWithFragmentRootViews.push(path)
      }
    })
    const allRoots = MetadataUtils.getAllCanvasRootPaths(componentMetadata).filter((rootPath) => {
      return !rootElementsToFilter.some((path) => EP.pathsEqual(rootPath, path))
    })
    let siblings: Array<ElementPath> = []
    Utils.fastForEach(selectedViews, (view) => {
      const allPaths = childrenSelectable
        ? EP.allPathsForLastPart(view)
        : EP.allPathsForLastPart(EP.parentPath(view))
      Utils.fastForEach(allPaths, (ancestor) => {
        const {
          children,
          unfurledComponents,
        } = MetadataUtils.getAllChildrenIncludingUnfurledFocusedComponents(
          ancestor,
          componentMetadata,
        )
        const ancestorChildren = [...children, ...unfurledComponents]
        fastForEach(ancestorChildren, (child) => siblings.push(child))
      })
    })

    const selectableViews = [...dynamicScenesWithFragmentRootViews, ...allRoots, ...siblings]
    const uniqueSelectableViews = uniqBy<ElementPath>(selectableViews, EP.pathsEqual)

    candidateViews = uniqueSelectableViews
  }

  return filterHiddenInstances(hiddenInstances, candidateViews)
}

function useFindValidTarget(): (
  selectableViews: Array<ElementPath>,
  mousePoint: WindowPoint | null,
) => {
  elementPath: ElementPath
  isSelected: boolean
} | null {
  const storeRef = useRefEditorState((store) => {
    return {
      componentMetadata: store.editor.jsxMetadata,
      selectedViews: store.editor.selectedViews,
      hiddenInstances: store.editor.hiddenInstances,
      canvasScale: store.editor.canvas.scale,
      canvasOffset: store.editor.canvas.realCanvasOffset,
      focusedElementPath: store.editor.focusedElementPath,
    }
  })

  return React.useCallback(
    (selectableViews: Array<ElementPath>, mousePoint: WindowPoint | null) => {
      const {
        selectedViews,
        componentMetadata,
        hiddenInstances,
        canvasScale,
        canvasOffset,
      } = storeRef.current
      const validElementMouseOver: ElementPath | null = getValidTargetAtPoint(
        componentMetadata,
        selectedViews,
        hiddenInstances,
        selectableViews,
        mousePoint,
        canvasScale,
        canvasOffset,
      )
      const validElementPath: ElementPath | null =
        validElementMouseOver != null ? validElementMouseOver : null
      if (validElementPath != null) {
        const isSelected = selectedViews.some((selectedView) =>
          EP.pathsEqual(validElementPath, selectedView),
        )
        return {
          elementPath: validElementPath,
          isSelected: isSelected,
        }
      } else {
        return null
      }
    },
    [storeRef],
  )
}

function useStartDragState(): (
  target: ElementPath,
  start: CanvasPoint | null,
) => (event: MouseEvent) => void {
  const dispatch = useEditorState((store) => store.dispatch, 'useStartDragState dispatch')
  const entireEditorStoreRef = useRefEditorState((store) => store)

  return React.useCallback(
    (target: ElementPath, start: CanvasPoint | null) => (event: MouseEvent) => {
      if (start == null) {
        return
      }

      const componentMetadata = entireEditorStoreRef.current.editor.jsxMetadata
      const selectedViews = entireEditorStoreRef.current.editor.selectedViews

      const duplicate = event.altKey
      const duplicateNewUIDs = duplicate
        ? createDuplicationNewUIDs(
            selectedViews,
            componentMetadata,
            entireEditorStoreRef.current.editor.projectContents,
          )
        : null

      const isTargetSelected = selectedViews.some((sv) => EP.pathsEqual(sv, target))

      const moveTargets =
        isTargetSelected && EP.areAllElementsInSameInstance(selectedViews)
          ? selectedViews
          : [target]

      let originalFrames = getOriginalCanvasFrames(moveTargets, componentMetadata)
      originalFrames = originalFrames.filter((f) => f.frame != null)

      const selectionArea = boundingRectangleArray(
        selectedViews.map((view) => {
          return MetadataUtils.getFrameInCanvasCoords(view, componentMetadata)
        }),
      )

      dispatch([
        CanvasActions.createDragState(
          moveDragState(
            start,
            null,
            null,
            originalFrames,
            selectionArea,
            !event.metaKey,
            event.shiftKey,
            duplicate,
            event.metaKey,
            duplicateNewUIDs,
            start,
            componentMetadata,
            moveTargets,
          ),
        ),
      ])
    },
    [dispatch, entireEditorStoreRef],
  )
}

function useStartCanvasSession(): (event: MouseEvent, target: ElementPath) => void {
  const dispatch = useEditorState((store) => store.dispatch, 'useStartDragState dispatch')
  const windowToCanvasCoordinates = useWindowToCanvasCoordinates()

  return React.useCallback(
    (event: MouseEvent, target: ElementPath) => {
      const start = windowToCanvasCoordinates(windowPoint(point(event.clientX, event.clientY)))
        .canvasPositionRounded

      dispatch([
        CanvasActions.createInteractionSession(
          createInteractionViaMouse(start, Modifier.modifiersForEvent(event), {
            type: 'BOUNDING_AREA',
            target: target,
          }),
        ),
      ])
    },
    [dispatch, windowToCanvasCoordinates],
  )
}

function callbackAfterDragExceedsThreshold(
  startEvent: MouseEvent,
  threshold: number,
  callback: (event: MouseEvent) => void,
) {
  const startPoint = windowPoint(point(startEvent.clientX, startEvent.clientY))
  function onMouseMove(event: MouseEvent) {
    if (distance(startPoint, windowPoint(point(event.clientX, event.clientY))) > threshold) {
      callback(event)
      removeListeners()
    }
  }

  function onMouseUp() {
    removeListeners()
  }

  function removeListeners() {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

export function useStartDragStateAfterDragExceedsThreshold(): (
  nativeEvent: MouseEvent,
  foundTarget: ElementPath,
) => void {
  const startDragState = useStartDragState()

  const windowToCanvasCoordinates = useWindowToCanvasCoordinates()

  const startDragStateAfterDragExceedsThreshold = React.useCallback(
    (nativeEvent: MouseEvent, foundTarget: ElementPath) => {
      const startPoint = windowToCanvasCoordinates(
        windowPoint(point(nativeEvent.clientX, nativeEvent.clientY)),
      ).canvasPositionRounded

      callbackAfterDragExceedsThreshold(
        nativeEvent,
        DRAG_START_TRESHOLD,
        startDragState(foundTarget, startPoint),
      )
    },
    [startDragState, windowToCanvasCoordinates],
  )

  return startDragStateAfterDragExceedsThreshold
}

export function useGetSelectableViewsForSelectMode() {
  const storeRef = useRefEditorState((store) => {
    return {
      componentMetadata: store.editor.jsxMetadata,
      selectedViews: store.editor.selectedViews,
      hiddenInstances: store.editor.hiddenInstances,
      focusedElementPath: store.editor.focusedElementPath,
    }
  })

  return React.useCallback(
    (allElementsDirectlySelectable: boolean, childrenSelectable: boolean) => {
      const { componentMetadata, selectedViews, hiddenInstances } = storeRef.current
      const selectableViews = getSelectableViews(
        componentMetadata,
        selectedViews,
        hiddenInstances,
        allElementsDirectlySelectable,
        childrenSelectable,
      )
      return selectableViews
    },
    [storeRef],
  )
}

export function useCalculateHighlightedViews(
  allowHoverOnSelectedView: boolean,
  getHighlightableViews: (
    allElementsDirectlySelectable: boolean,
    childrenSelectable: boolean,
  ) => ElementPath[],
): (targetPoint: WindowPoint, eventCmdPressed: boolean) => void {
  const { maybeHighlightOnHover, maybeClearHighlightsOnHoverEnd } = useMaybeHighlightElement()
  const findValidTarget = useFindValidTarget()
  return React.useCallback(
    (targetPoint: WindowPoint, eventCmdPressed: boolean) => {
      const selectableViews: Array<ElementPath> = getHighlightableViews(eventCmdPressed, false)
      const validElementPath = findValidTarget(selectableViews, targetPoint)
      if (
        validElementPath == null ||
        (!allowHoverOnSelectedView && validElementPath.isSelected) // we remove highlights if the hovered element is selected
      ) {
        maybeClearHighlightsOnHoverEnd()
      } else {
        maybeHighlightOnHover(validElementPath.elementPath)
      }
    },
    [
      allowHoverOnSelectedView,
      maybeClearHighlightsOnHoverEnd,
      maybeHighlightOnHover,
      getHighlightableViews,
      findValidTarget,
    ],
  )
}

export function useHighlightCallbacks(
  active: boolean,
  cmdPressed: boolean,
  allowHoverOnSelectedView: boolean,
  getHighlightableViews: (
    allElementsDirectlySelectable: boolean,
    childrenSelectable: boolean,
  ) => ElementPath[],
): {
  onMouseMove: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void
} {
  const calculateHighlightedViews = useCalculateHighlightedViews(
    allowHoverOnSelectedView,
    getHighlightableViews,
  )

  const onMouseMove = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      return calculateHighlightedViews(
        windowPoint(point(event.clientX, event.clientY)),
        event.metaKey,
      )
    },
    [calculateHighlightedViews],
  )

  React.useEffect(() => {
    if (active && WindowMousePositionRaw != null) {
      // this useEffect will re-calculate (and update) the highlighted views if the user presses or releases 'cmd' without moving the mouse,
      // or if the user enters a new mode (the `active` flag will change for the modes), this is important when entering insert mode
      calculateHighlightedViews(WindowMousePositionRaw, cmdPressed)
    }
  }, [calculateHighlightedViews, active, cmdPressed])

  return { onMouseMove }
}

function useSelectOrLiveModeSelectAndHover(
  active: boolean,
  draggingAllowed: boolean,
  cmdPressed: boolean,
  setSelectedViewsForCanvasControlsOnly: (newSelectedViews: ElementPath[]) => void,
): {
  onMouseMove: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void
  onMouseDown: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void
} {
  const dispatch = useEditorState((store) => store.dispatch, 'useSelectAndHover dispatch')
  const selectedViewsRef = useRefEditorState((store) => store.editor.selectedViews)
  const findValidTarget = useFindValidTarget()
  const getSelectableViewsForSelectMode = useGetSelectableViewsForSelectMode()
  const startDragStateAfterDragExceedsThreshold = useStartDragStateAfterDragExceedsThreshold()
  const startCanvasModeSession = useStartCanvasSession()

  const { onMouseMove } = useHighlightCallbacks(
    active,
    cmdPressed,
    false,
    getSelectableViewsForSelectMode,
  )

  const editorStoreRef = useRefEditorState((store) => ({
    editor: store.editor,
    derived: store.derived,
  }))

  const innerAnimationFrameRef = React.useRef<number | null>(null)

  const onMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const doubleClick = event.detail > 1 // we interpret a triple click as two double clicks, a quadruple click as three double clicks, etc  // TODO TEST ME
      const selectableViews = getSelectableViewsForSelectMode(event.metaKey, doubleClick)
      const foundTarget = findValidTarget(
        selectableViews,
        windowPoint(point(event.clientX, event.clientY)),
      )

      const isMultiselect = event.shiftKey
      const isDeselect = foundTarget == null && !isMultiselect

      if (foundTarget != null || isDeselect) {
        if (foundTarget != null && draggingAllowed) {
          if (isFeatureEnabled('Canvas Strategies')) {
            startCanvasModeSession(event.nativeEvent, foundTarget.elementPath)
          } else {
            startDragStateAfterDragExceedsThreshold(event.nativeEvent, foundTarget.elementPath)
          }
        }

        let updatedSelection: Array<ElementPath>
        if (isMultiselect) {
          updatedSelection = EP.addPathIfMissing(foundTarget!.elementPath, selectedViewsRef.current)
        } else {
          updatedSelection = foundTarget != null ? [foundTarget.elementPath] : []
        }

        if (foundTarget != null && doubleClick) {
          // for components without passed children doubleclicking enters focus mode
          const isFocusableLeaf = MetadataUtils.isFocusableLeafComponent(
            foundTarget.elementPath,
            editorStoreRef.current.editor.jsxMetadata,
          )
          if (isFocusableLeaf) {
            dispatch([setFocusedElement(foundTarget.elementPath)])
          }
        }

        if (!(foundTarget?.isSelected ?? false)) {
          // first we only set the selected views for the canvas controls
          setSelectedViewsForCanvasControlsOnly(updatedSelection)

          requestAnimationFrame(() => {
            if (innerAnimationFrameRef.current != null) {
              window.cancelAnimationFrame(innerAnimationFrameRef.current)
            }
            innerAnimationFrameRef.current = requestAnimationFrame(() => {
              // then we set the selected views for the editor state, 1 frame later
              if (updatedSelection.length === 0) {
                const clearFocusedElementIfFeatureSwitchEnabled = isFeatureEnabled(
                  'Click on empty canvas unfocuses',
                )
                  ? [setFocusedElement(null)]
                  : []

                dispatch([clearSelection(), ...clearFocusedElementIfFeatureSwitchEnabled])
              } else {
                dispatch([selectComponents(updatedSelection, event.shiftKey)])
              }
            })
          })
        }
      }
    },
    [
      dispatch,
      selectedViewsRef,
      findValidTarget,
      startDragStateAfterDragExceedsThreshold,
      setSelectedViewsForCanvasControlsOnly,
      getSelectableViewsForSelectMode,
      editorStoreRef,
      draggingAllowed,
      startCanvasModeSession,
    ],
  )

  return { onMouseMove, onMouseDown }
}

export function useSelectAndHover(
  cmdPressed: boolean,
  setSelectedViewsForCanvasControlsOnly: (newSelectedViews: ElementPath[]) => void,
): {
  onMouseMove: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void
  onMouseDown: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void
} {
  const modeType = useEditorState((store) => store.editor.mode.type, 'useSelectAndHover mode')
  const hasInteractionSession = useEditorState(
    (store) => store.editor.canvas.interactionSession != null,
    'useSelectAndHover hasInteractionSession',
  )
  const selectModeCallbacks = useSelectOrLiveModeSelectAndHover(
    modeType === 'select' || modeType === 'select-lite' || modeType === 'live',
    modeType === 'select' || modeType === 'live',
    cmdPressed,
    setSelectedViewsForCanvasControlsOnly,
  )
  const insertModeCallbacks = useInsertModeSelectAndHover(modeType === 'insert', cmdPressed)

  if (hasInteractionSession) {
    return {
      onMouseMove: Utils.NO_OP,
      onMouseDown: Utils.NO_OP,
    }
  } else {
    switch (modeType) {
      case 'select':
        return selectModeCallbacks
      case 'select-lite':
        return selectModeCallbacks
      case 'insert':
        return insertModeCallbacks
      case 'live':
        return selectModeCallbacks
      default:
        const _exhaustiveCheck: never = modeType
        throw new Error(`Unhandled editor mode ${JSON.stringify(modeType)}`)
    }
  }
}
